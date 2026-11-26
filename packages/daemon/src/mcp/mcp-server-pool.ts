import {
  mcpFetchToolsList,
  mcpInvokeTool,
  mcpToolsToSourceCatalog,
  openMcpStdioClient,
  openMcpStreamableHttpClient,
  openMcpTcpClient,
  type McpJsonRpcSession,
  type McpSourceCatalog,
  type McpStreamableHttpServerMessage,
  type McpStreamableHttpSession,
  type McpStdioConnectOptions,
} from "@shoggoth/mcp-integration";
import { getProcessManager } from "../process-manager-singleton";
import { getLogger } from "../logging";
import { truncateResultJson } from "../sessions/builtin-handlers/truncate-output";
import type { ShoggothMcpConfig, ShoggothMcpServerEntry } from "@shoggoth/shared";
import type { ExternalMcpInvoke } from "./tool-loop-mcp";
import { resolveVaultEnv } from "./vault-env-resolve";
import type { VaultService } from "../vault/vault-service";

const log = getLogger("mcp-pool");

// Connect retry + circuit breaker: every per-server connect attempt covers
// the WHOLE handshake (spawn, connect, initialize, tools/list), so any
// failure mode — spawn errors, early death, protocol errors — is retried.

/** Max connect attempts per server per pool connect (first try + retries). */
const MCP_CONNECT_MAX_ATTEMPTS = 3;
/** Base delay before the first retry; doubles after each failed attempt. */
const MCP_CONNECT_RETRY_BASE_MS = 250;
/** Upper bound for the exponential backoff delay between attempts. */
const MCP_CONNECT_RETRY_MAX_MS = 4_000;

/** Per-server circuit-breaker state, keyed by configured server id. */
type McpServerCircuit = {
  /** Failed connect attempts recorded in the current closed window. */
  attempts: number;
  /** True once the retry budget is exhausted; no attempts until re-armed. */
  open: boolean;
  lastError?: string;
};

const mcpServerCircuits = new Map<string, McpServerCircuit>();

/**
 * Close every server circuit (start a fresh window). Called by tests and by
 * callers that want to force a full retry budget on the next connect; pool
 * connects re-arm their own servers by default (`rearmCircuits`).
 */
export function resetMcpServerConnectCircuits(): void {
  mcpServerCircuits.clear();
}

/** True while a server's circuit breaker is open (retry budget exhausted). */
export function isMcpServerCircuitOpen(serverId: string): boolean {
  return mcpServerCircuits.get(serverId)?.open === true;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type EffectiveMcpPoolScope = "global" | "per_agent" | "per_session";

/** Shape common to the stdio/tcp notification tap and the streamable HTTP server-message tap. */
type ServerNotificationLike = { readonly method?: unknown; readonly id?: unknown };

/** Resolve `entry.poolScope ?? "inherit"` then map `inherit` → top-level `mcp.poolScope`. */
function effectiveMcpPoolScope(
  entry: ShoggothMcpServerEntry,
  topLevelPoolScope: ShoggothMcpConfig["poolScope"],
): EffectiveMcpPoolScope {
  const p = entry.poolScope ?? "inherit";
  if (p === "inherit") return topLevelPoolScope;
  return p;
}

/** Split configured servers by effective pool scope (global, per-agent, or per-session). */
export function partitionMcpServersByEffectiveScope(
  servers: readonly ShoggothMcpServerEntry[],
  topLevelPoolScope: ShoggothMcpConfig["poolScope"],
): {
  globalServers: ShoggothMcpServerEntry[];
  perAgentServers: ShoggothMcpServerEntry[];
  perSessionServers: ShoggothMcpServerEntry[];
} {
  const globalServers: ShoggothMcpServerEntry[] = [];
  const perAgentServers: ShoggothMcpServerEntry[] = [];
  const perSessionServers: ShoggothMcpServerEntry[] = [];
  for (const s of servers) {
    const scope = effectiveMcpPoolScope(s, topLevelPoolScope);
    if (scope === "global") {
      globalServers.push(s);
    } else if (scope === "per_agent") {
      perAgentServers.push(s);
    } else {
      perSessionServers.push(s);
    }
  }
  return { globalServers, perAgentServers, perSessionServers };
}

export type McpServerPool = {
  /**
   * Live tool catalogs in config order. When a server signals
   * `notifications/tools/list_changed`, its entry is replaced **in place** (same
   * array identity, same index) after a `tools/list` re-fetch — hold the array
   * reference rather than snapshotting its contents. The same in-place swap
   * happens after a dead stdio/tcp server is respawned, so consumers holding
   * the array reference see the refreshed catalog.
   */
  readonly externalSources: readonly McpSourceCatalog[];
  /**
   * Streamable HTTP only: sends MCP `notifications/cancelled` for `requestId` on the session for `sourceId`.
   * Returns true if that server is an HTTP transport pool member.
   */
  readonly cancelMcpRequest?: (sourceId: string, requestId: number) => boolean;
  /**
   * Observer tap: fired once per observed server death (stdio process exit, or
   * stream end/error on stdio-direct/tcp) before respawn bookkeeping completes.
   * Streams dying as part of a deliberate `close()` never fire it.
   */
  onServerExit?: (info: {
    readonly sourceId: string;
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }) => void;
  /** True when the given source has a session that has not been observed dead. */
  readonly isServerLive?: (sourceId: string) => boolean;
  /** True when no session in this pool has been observed dead (empty pools: true). */
  readonly hasLiveServers?: () => boolean;
  readonly close: () => Promise<void>;
};

/** Agent identity and workspace context for scoped MCP server processes. */
export interface AgentMcpContext {
  /** POSIX UID for the agent (from session row or bootstrap). */
  readonly uid: number;
  /** POSIX GID for the agent (from session row or bootstrap). */
  readonly gid: number;
  /** Absolute path to the agent's workspace directory. */
  readonly workspacePath: string;
}

export type ConnectShoggothMcpPoolOptions = {
  readonly onMcpServerMessage?: (input: {
    sourceId: string;
    msg: McpStreamableHttpServerMessage;
  }) => void;
  /** When provided, stdio MCP servers are spawned under this agent's identity. */
  readonly agentContext?: AgentMcpContext;
  /** Vault service for resolving $vault: references in env vars. */
  readonly vault?: VaultService;
  /** Agent ID for vault scope resolution. Required if vault is provided. */
  readonly agentId?: string;
  /**
   * Invoked after a source's tool catalog has been re-fetched and replaced in
   * place in `pool.externalSources` because that server sent
   * `notifications/tools/list_changed`. Consumers that snapshot catalogs (e.g.
   * cached session MCP contexts) should invalidate on this so the next
   * `resolveContext` rebuilds from the refreshed arrays.
   */
  readonly onToolCatalogChange?: (input: { sourceId: string }) => void;
  /**
   * Re-arm (close) the circuit breakers of the servers in this connect before
   * attempting them, granting each a fresh retry budget. Defaults to true, so
   * every explicit pool connect retries normally. Pass false from automatic
   * reconnect paths: servers whose breaker is open then fail fast without
   * spawning, which is what keeps repeated `resolveContext`-driven reconnects
   * from re-running the retry budget (churn).
   */
  readonly rearmCircuits?: boolean;
  /** Per-connect retry knobs (defaults: 3 attempts, 250 ms base, x2 backoff). */
  readonly connectRetry?: {
    readonly attempts?: number;
    readonly baseDelayMs?: number;
  };
  /**
   * Test seam: overrides how stdio servers are opened. Defaults to the real
   * `openMcpStdioClient`. Injecting here is preferred over mocking the
   * `@shoggoth/mcp-integration` module, because under vitest `--no-isolate`
   * the shared module cache can defeat `vi.mock` when another file imports the
   * real module first — DI stays isolation-proof regardless of file order.
   */
  readonly openStdioClient?: (opts: McpStdioConnectOptions) => Promise<McpJsonRpcSession>;
};

/** Per-server outcome of a pool start, gathered asynchronously across parallel connects. */
export type McpServerConnectStatus = {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
  /** Connect attempts consumed in this pool connect (0 when skipped by an open circuit). */
  readonly attempts?: number;
  /** True when this server's circuit breaker is open (retry budget exhausted). */
  readonly circuitOpen?: boolean;
};

type McpServerStartOutcome = {
  readonly status: McpServerConnectStatus;
  readonly session?: McpJsonRpcSession;
  readonly httpSession?: McpStreamableHttpSession;
  readonly catalog?: McpSourceCatalog;
};

/**
 * Connects configured MCP servers (stdio, TCP, or streamable HTTP) in parallel, runs
 * `initialize` + `tools/list` on each, and returns catalogs plus a {@link ExternalMcpInvoke}
 * that routes `tools/call` to the right session.
 *
 * Outcomes are gathered per server: a server that fails to connect is skipped (its
 * partially-opened session is closed, never leaked) while the rest join the pool in config
 * order. If every configured server fails, an `AggregateError` is thrown.
 */
export async function connectShoggothMcpServers(
  servers: readonly ShoggothMcpServerEntry[],
  options?: ConnectShoggothMcpPoolOptions,
): Promise<{
  pool: McpServerPool;
  external: ExternalMcpInvoke;
  /** Always set by this implementation; optional so injected fakes stay assignable. */
  statuses?: readonly McpServerConnectStatus[];
}> {
  const externalSources: McpSourceCatalog[] = [];
  const sessions = new Map<string, McpJsonRpcSession>();
  const streamableBySourceId = new Map<string, McpStreamableHttpSession>();
  const onPoolMessage = options?.onMcpServerMessage;
  /** Set once a session for that server has been observed dead (exit/stream end). */
  const deadServers = new Set<string>();
  /** In-flight respawn per server id; concurrent death events coalesce on one handshake. */
  const respawning = new Map<string, Promise<boolean>>();
  /**
   * Crash-loop guard bookkeeping: deaths that strike again within
   * {@link RESPAWN_STABLE_WINDOW_MS} of the last successful respawn count as
   * consecutive crash-loop failures; a death of a long-lived session resets
   * the streak (genuinely healthy servers that later die get respawned).
   */
  const respawnStreak = new Map<string, number>();
  const respawnOkAt = new Map<string, number>();
  /** Consecutive rapid re-deaths before the pool stops auto-respawning. */
  const MAX_RESPAWN_STREAK = 3;
  /** A respawned session counts as "stable" once it lives this long. */
  const RESPAWN_STABLE_WINDOW_MS = 10_000;
  /** Base delay before a respawn attempt (doubles per streak). */
  const RESPAWN_BASE_DELAY_MS = 250;
  /** Upper bound for the respawn backoff delay. */
  const RESPAWN_MAX_DELAY_MS = 8_000;
  let poolClosed = false;
  /** Set after the pool object exists; death events read the observer tap from it. */
  let poolObj: McpServerPool | undefined;

  const agentCtx = options?.agentContext;

  // ── tools/list_changed handling ─────────────────────────────────────
  // Per-source coalescing state: a burst of notifications while a refresh is
  // in flight queues exactly one follow-up fetch instead of stacking calls.
  const toolCatalogRefreshing = new Set<string>();
  const toolCatalogRefreshQueued = new Set<string>();

  /**
   * React to an inbound server message: on `notifications/tools/list_changed`,
   * re-fetch `tools/list` and replace that source's catalog entry in place.
   * Only id-less messages with the method are considered (JSON-RPC
   * notification); servers that never advertised `capabilities.tools.listChanged`
   * simply never trigger this path.
   */
  function handleServerNotification(sourceId: string, msg: ServerNotificationLike): void {
    if (msg.id !== undefined && msg.id !== null) return;
    if (msg.method !== "notifications/tools/list_changed") return;
    refreshToolCatalog(sourceId);
  }

  /**
   * Re-fetch `tools/list` for one source and swap its catalog entry in place
   * (same `externalSources` array, same index — other components hold the array
   * reference). Runs as floating work so a notification never blocks or rejects
   * the transport's message loop. On failure the previous catalog is kept and the
   * error logged — a transient error never blanks a working catalog. On success,
   * `options.onToolCatalogChange` fires so consumers can invalidate snapshots.
   */
  function refreshToolCatalog(sourceId: string): void {
    if (toolCatalogRefreshing.has(sourceId)) {
      toolCatalogRefreshQueued.add(sourceId);
      return;
    }
    toolCatalogRefreshing.add(sourceId);
    void (async () => {
      try {
        const session = sessions.get(sourceId);
        if (!session) return; // server not (yet) registered in this pool
        const tools = await mcpFetchToolsList(session);
        const idx = externalSources.findIndex((c) => c.sourceId === sourceId);
        if (idx === -1) return;
        externalSources[idx] = mcpToolsToSourceCatalog(sourceId, tools);
        options?.onToolCatalogChange?.({ sourceId });
      } catch (e) {
        log.warn("mcp.pool.tool_catalog_refresh_failed", { sourceId, err: String(e) });
      } finally {
        toolCatalogRefreshing.delete(sourceId);
        if (toolCatalogRefreshQueued.delete(sourceId)) {
          refreshToolCatalog(sourceId);
        }
      }
    })().catch((e) => {
      log.error("mcp.pool.tool_catalog_refresh_crashed", { sourceId, err: String(e) });
    });
  }

  /**
   * Reconnect one dead server in place: fresh handshake (spawn → initialize →
   * tools/list) through the normal retry/circuit path with the circuit
   * re-armed (an explicit recovery, not churn), then swap the live session
   * into the `sessions` map and replace the catalog entry in place.
   * Concurrent death events for one server coalesce on a single handshake.
   * Returns true when the server is live again.
   */
  function respawnServer(s: ShoggothMcpServerEntry): Promise<boolean> {
    const existing = respawning.get(s.id);
    if (existing) return existing;
    // Crash-loop guard: after N rapid re-deaths the pool stops auto-respawning
    // this server. The next EXPLICIT pool connect re-arms it.
    if ((respawnStreak.get(s.id) ?? 0) >= MAX_RESPAWN_STREAK) {
      log.warn("mcp.pool.server_respawn_suppressed", {
        sourceId: s.id,
        streak: respawnStreak.get(s.id),
      });
      return Promise.resolve(false);
    }
    const attempt = (async () => {
      try {
        // Backoff between respawn attempts (doubles per streak): a server that
        // dies immediately after every handshake must not turn into an
        // unbounded spawn/exit loop.
        const streak = respawnStreak.get(s.id) ?? 0;
        if (streak > 0) {
          const delayMs = Math.min(RESPAWN_BASE_DELAY_MS * 2 ** (streak - 1), RESPAWN_MAX_DELAY_MS);
          await sleep(delayMs);
        }
        // Re-arm this server's circuit: respawn is an explicit recovery path.
        const circuit = mcpServerCircuits.get(s.id);
        if (circuit) {
          circuit.attempts = 0;
          circuit.open = false;
          circuit.lastError = undefined;
        }
        const outcome = await startServer(s);
        // The old (dead) session object is always released: its procman
        // registration must not leak even though the pool no longer routes
        // through it.
        const stale = sessions.get(s.id);
        const dropStale = () => {
          if (stale) void stale.close().catch(() => {});
        };
        if (!outcome.session || !outcome.catalog || !outcome.status.ok) {
          // A stale entry must never keep serving the dead process.
          if (stale && deadServers.has(s.id)) {
            sessions.delete(s.id);
            dropStale();
          }
          log.warn("mcp.pool.server_respawn_failed", {
            sourceId: s.id,
            err: outcome.status.error,
          });
          return false;
        }
        dropStale();
        sessions.set(s.id, outcome.session);
        deadServers.delete(s.id);
        const idx = externalSources.findIndex((c) => c.sourceId === s.id);
        if (idx !== -1) {
          externalSources[idx] = outcome.catalog;
          options?.onToolCatalogChange?.({ sourceId: s.id });
        } else {
          externalSources.push(outcome.catalog);
        }
        log.info("mcp.pool.server_respawn_ok", {
          sourceId: s.id,
          attempts: outcome.status.attempts,
        });
        respawnOkAt.set(s.id, Date.now());
        return true;
      } catch (e) {
        log.warn("mcp.pool.server_respawn_failed", { sourceId: s.id, err: String(e) });
        return false;
      } finally {
        respawning.delete(s.id);
      }
    })();
    respawning.set(s.id, attempt);
    return attempt;
  }

  /**
   * Death handler wired to the session's exit tap: mark dead, notify the
   * observer, and fire-and-forget the in-place respawn. The `external` invoke
   * closure reads the `sessions` map per call, so swapping the session repairs
   * routing for every cached context without any reconnect handshake.
   */
  function handleSessionDeath(
    s: ShoggothMcpServerEntry,
    info: {
      readonly reason: "stream_end" | "stream_error" | "process_exit";
      readonly exitCode?: number | null;
      readonly signal?: NodeJS.Signals | null;
    },
  ): void {
    if (poolClosed) return;
    if (deadServers.has(s.id)) return;
    deadServers.add(s.id);
    // Crash-loop accounting: a re-death within the stability window of the
    // last successful respawn extends the streak; a death of a session that
    // had been up for a while resets it (healthy server, one-off crash).
    const lastOk = respawnOkAt.get(s.id);
    if (lastOk !== undefined) {
      if (Date.now() - lastOk < RESPAWN_STABLE_WINDOW_MS) {
        respawnStreak.set(s.id, (respawnStreak.get(s.id) ?? 0) + 1);
      } else {
        respawnStreak.delete(s.id);
      }
    }
    poolObj?.onServerExit?.({
      sourceId: s.id,
      exitCode: info.exitCode ?? null,
      signal: info.signal ?? null,
    });
    log.warn("mcp.pool.server_exited", {
      sourceId: s.id,
      reason: info.reason,
      exitCode: info.exitCode ?? null,
      signal: info.signal ?? null,
    });
    void respawnServer(s);
  }

  /** Open one server (env/vault resolution + connect + `tools/list`) in isolation. */
  async function startServer(s: ShoggothMcpServerEntry): Promise<McpServerStartOutcome> {
    const rearm = options?.rearmCircuits ?? true;
    const maxAttempts = Math.max(1, options?.connectRetry?.attempts ?? MCP_CONNECT_MAX_ATTEMPTS);
    const baseDelayMs = options?.connectRetry?.baseDelayMs ?? MCP_CONNECT_RETRY_BASE_MS;

    let circuit = mcpServerCircuits.get(s.id);
    if (rearm) {
      if (circuit?.open) {
        log.info("mcp.pool.circuit_rearm", {
          sourceId: s.id,
          previousAttempts: circuit.attempts,
          lastError: circuit.lastError,
        });
      }
      circuit = { attempts: 0, open: false };
      mcpServerCircuits.set(s.id, circuit);
    } else if (circuit?.open) {
      // Circuit open and no re-arm requested: fail fast WITHOUT spawning so
      // automatic reconnects never re-run the retry budget for this server.
      log.warn("mcp.pool.circuit_open_skip", {
        sourceId: s.id,
        attempts: circuit.attempts,
        err: circuit.lastError,
      });
      return {
        status: {
          id: s.id,
          ok: false,
          error:
            `circuit open: connect failed ${circuit.attempts} time(s) previously` +
            (circuit.lastError ? ` (${circuit.lastError})` : ""),
          attempts: 0,
          circuitOpen: true,
        },
      };
    }
    if (!circuit) {
      // First time we see this server (e.g. rearm=false on a fresh id).
      circuit = { attempts: 0, open: false };
      mcpServerCircuits.set(s.id, circuit);
    }

    let lastError = "unknown error";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let session: McpJsonRpcSession | undefined;
      let httpSession: McpStreamableHttpSession | undefined;
      try {
        if (s.transport === "stdio") {
          // Build env: inherit process.env, override HOME for agent workspace,
          // server config env takes highest priority
          let baseEnv = {
            ...process.env,
            ...(agentCtx ? { HOME: agentCtx.workspacePath } : {}),
            ...s.env,
          };
          // Resolve $vault: references in env vars if vault is available
          if (baseEnv && options?.vault) {
            baseEnv = await resolveVaultEnv(baseEnv, options.vault, options.agentId);
          }
          const cwd = s.cwd ?? agentCtx?.workspacePath;
          const openStdio = options?.openStdioClient ?? openMcpStdioClient;
          session = await openStdio({
            command: s.command,
            args: s.args,
            cwd,
            env: baseEnv,
            uid: agentCtx?.uid,
            gid: agentCtx?.gid,
            processManager: getProcessManager(),
            onServerNotification: (msg) => handleServerNotification(s.id, msg),
            onServerExit: (info) =>
              handleSessionDeath(s, {
                reason: "process_exit",
                exitCode: info.exitCode,
                signal: info.signal,
              }),
          });
        } else if (s.transport === "tcp") {
          session = await openMcpTcpClient({
            host: s.host,
            port: s.port,
            onServerNotification: (msg) => handleServerNotification(s.id, msg),
          });
        } else {
          httpSession = await openMcpStreamableHttpClient({
            url: s.url,
            headers: s.headers,
            // Always wired: the HTTP transport funnels id-less notifications
            // through onServerMessage (one shared dispatch), so the tap
            // doubles as the tools/list_changed trigger.
            onServerMessage: (msg) => {
              onPoolMessage?.({ sourceId: s.id, msg });
              handleServerNotification(s.id, msg);
            },
          });
          session = httpSession;
        }
        const tools = await mcpFetchToolsList(session);
        if (circuit) {
          circuit.attempts = 0;
          circuit.open = false;
          circuit.lastError = undefined;
        }
        return {
          status: { id: s.id, ok: true, attempts: attempt },
          session,
          httpSession,
          catalog: mcpToolsToSourceCatalog(s.id, tools),
        };
      } catch (e) {
        // Never leak a partially-opened session when this server fails.
        if (session) await session.close().catch(() => {});
        lastError = String(e);
        if (circuit) circuit.attempts += 1;
        if (attempt < maxAttempts) {
          const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), MCP_CONNECT_RETRY_MAX_MS);
          log.warn("mcp.pool.connect_retry", {
            sourceId: s.id,
            attempt,
            maxAttempts,
            delayMs,
            err: lastError,
          });
          await sleep(delayMs);
        }
      }
    }

    // Retry budget exhausted: open the circuit for this server. It stays open
    // (no further automatic attempts) until the next explicit pool connect
    // re-arms it.
    if (circuit) {
      circuit.open = true;
      circuit.lastError = lastError;
    }
    log.warn("mcp.pool.circuit_open", {
      sourceId: s.id,
      attempts: maxAttempts,
      err: lastError,
    });
    return {
      status: { id: s.id, ok: false, error: lastError, attempts: maxAttempts, circuitOpen: true },
    };
  }

  // Start every configured server concurrently; Promise.all preserves input order, so
  // results are assembled in config order regardless of which server completes first.
  const outcomes = await Promise.all(servers.map((s) => startServer(s)));
  const statuses: McpServerConnectStatus[] = outcomes.map((o) => o.status);

  const failed = outcomes.filter((o) => !o.status.ok);
  if (failed.length > 0 && failed.length === servers.length) {
    const errors = failed.map((o) => new Error(`${o.status.id}: ${o.status.error}`));
    throw new AggregateError(
      errors,
      `all ${servers.length} configured MCP server(s) failed to connect: ` +
        errors.map((e) => e.message).join("; "),
    );
  }

  for (const o of outcomes) {
    if (!o.session || !o.catalog) continue;
    sessions.set(o.status.id, o.session);
    externalSources.push(o.catalog);
    if (o.httpSession) streamableBySourceId.set(o.status.id, o.httpSession);
  }

  const external: ExternalMcpInvoke = async ({ sourceId, originalName, argsJson }) => {
    const session = sessions.get(sourceId);
    if (!session) {
      return {
        resultJson: JSON.stringify({
          error: "mcp_source_not_connected",
          sourceId,
          detail: "No active MCP session for this source id",
        }),
      };
    }
    try {
      const args = JSON.parse(argsJson) as Record<string, unknown>;
      const result = await mcpInvokeTool(session, originalName, args);
      return {
        resultJson: truncateResultJson(JSON.stringify(dropMcpStructuredContent(result))),
      };
    } catch (e) {
      return {
        resultJson: JSON.stringify({
          error: "mcp_tools_call_failed",
          message: String(e),
        }),
      };
    }
  };

  const pool: McpServerPool = {
    externalSources,
    cancelMcpRequest: (sourceId, requestId) => {
      const st = streamableBySourceId.get(sourceId);
      if (!st) return false;
      st.cancelRequest(requestId);
      return true;
    },
    isServerLive: (sourceId) => !deadServers.has(sourceId),
    hasLiveServers: () => deadServers.size === 0,
    close: async () => {
      poolClosed = true;
      const inflight = [...respawning.values()];
      await Promise.all(inflight);
      await Promise.all([...sessions.values()].map((x) => x.close().catch(() => {})));
    },
  };
  poolObj = pool;

  return { pool, external, statuses };
}

/**
 * The MCP protocol result for `tools/call` may carry the same payload twice:
 * once as `content` text parts and once as `structuredContent`. The model
 * sees the whole serialized object, so the duplicate doubles the token cost
 * of every structured result. Prefer `structuredContent` when present (it is
 * the machine-readable form) and drop the parallel `content` text; otherwise
 * return the result unchanged.
 */
export function dropMcpStructuredContent(result: unknown): unknown {
  if (
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    "structuredContent" in result &&
    (result as Record<string, unknown>).structuredContent != null
  ) {
    const { content: _dropped, ...rest } = result as Record<string, unknown>;
    void _dropped;
    return rest;
  }
  return result;
}
