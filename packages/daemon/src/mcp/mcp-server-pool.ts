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
} from "@shoggoth/mcp-integration";
import { getProcessManager } from "../process-manager-singleton";
import { getLogger } from "../logging";
import type { ShoggothMcpConfig, ShoggothMcpServerEntry } from "@shoggoth/shared";
import type { ExternalMcpInvoke } from "./tool-loop-mcp";
import { resolveVaultEnv } from "./vault-env-resolve";
import type { VaultService } from "../vault/vault-service";

const log = getLogger("mcp-pool");

// ── Connect retry + circuit breaker ─────────────────────────────────────────
//
// Every per-server connect attempt covers the WHOLE handshake (spawn, connect,
// initialize, tools/list), so any failure mode — spawn errors (ENOENT, EACCES,
// EMFILE, ENOEXEC, invalid uid/gid, ...), early process death, protocol
// errors, timeouts — is retried the same way.

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
   * reference rather than snapshotting its contents.
   */
  readonly externalSources: readonly McpSourceCatalog[];
  /**
   * Streamable HTTP only: sends MCP `notifications/cancelled` for `requestId` on the session for `sourceId`.
   * Returns true if that server is an HTTP transport pool member.
   */
  readonly cancelMcpRequest?: (sourceId: string, requestId: number) => boolean;
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
          session = await openMcpStdioClient({
            command: s.command,
            args: s.args,
            cwd,
            env: baseEnv,
            uid: agentCtx?.uid,
            gid: agentCtx?.gid,
            processManager: getProcessManager(),
            onServerNotification: (msg) => handleServerNotification(s.id, msg),
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
            // Always wired: the HTTP transport funnels id-less notifications through
            // onServerMessage (POST JSON, POST SSE, and standing GET SSE all share
            // one dispatch), so the tap doubles as the tools/list_changed trigger.
            // The optional debug log tap (SHOGGOTH_MCP_LOG_SERVER_MESSAGES) still
            // receives every forwarded message first.
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
      return { resultJson: JSON.stringify(result) };
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
    close: async () => {
      await Promise.all([...sessions.values()].map((x) => x.close().catch(() => {})));
    },
  };

  return { pool, external, statuses };
}
