import { createAggregateMcpCatalogResult, type McpSourceCatalog } from "@shoggoth/mcp-integration";
import type Database from "better-sqlite3";
import {
  SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS,
  type ShoggothConfig,
  evaluateMcpServerRules,
  resolveEffectiveMcpServerRules,
  isSubagentSessionUrn,
} from "@shoggoth/shared";
import { getLogger } from "../logging";
import {
  connectShoggothMcpServers,
  partitionMcpServersByEffectiveScope,
  type AgentMcpContext,
  type ConnectShoggothMcpPoolOptions,
  type McpServerConnectStatus,
} from "../mcp/mcp-server-pool";
import {
  registerMcpHttpCancelHandler,
  mcpAgentPoolKey,
  SHOGGOTH_GLOBAL_MCP_SESSION_KEY,
} from "../mcp/mcp-http-cancel-registry";
import type { ExternalMcpInvoke } from "../mcp/tool-loop-mcp";
import {
  buildBuiltinOnlySessionMcpToolContext,
  buildMixedSessionMcpToolContext,
  buildSessionMcpToolContext,
  buildThreeTierSessionMcpToolContext,
  createContextLevelToolFinalizer,
  createMcpServerRulesFinalizer,
  createMediaGenerateToolFinalizer,
  createVaultToolFinalizer,
  createWebSearchToolFinalizer,
  type SessionMcpToolContext,
} from "./session-mcp-tool-context";
import { listSkillsForConfig } from "@shoggoth/skills";
import { parseAgentSessionUrn, resolveAgentWorkspacePath, LAYOUT } from "@shoggoth/shared";
import { resolve } from "node:path";
import { createToolDiscoveryFinalizer } from "./session-tool-discovery";
import { createElevationToolFinalizer } from "./elevation-tool-finalizer";
import { createServiceToolFinalizer } from "./service-tool-finalizer";
import { resolveAgentCreds } from "../agent-creds";
import { vaultServiceRef } from "../vault/vault-ref";

const log = getLogger("session-mcp");

/** Emit one log line per server outcome gathered from a parallel pool start. */
function logMcpConnectStatuses(
  statuses: readonly McpServerConnectStatus[] | undefined,
  scope: Record<string, unknown>,
): void {
  for (const st of statuses ?? []) {
    if (st.ok) {
      log.info("session.mcp_pool.server_connected", {
        ...scope,
        sourceId: st.id,
        attempts: st.attempts,
      });
    } else {
      log.warn("session.mcp_pool.server_failed", {
        ...scope,
        sourceId: st.id,
        err: st.error,
        attempts: st.attempts,
        circuitOpen: st.circuitOpen,
      });
    }
  }
}

export type SessionMcpContextFinalizer = (
  ctx: SessionMcpToolContext,
  sessionId: string,
) => SessionMcpToolContext;

/** Pre-registration buffer for finalizers registered before a runtime is created. */
const pendingFinalizers: SessionMcpContextFinalizer[] = [];

export function registerContextFinalizer(fn: SessionMcpContextFinalizer): void {
  pendingFinalizers.push(fn);
}

export interface CreateSessionMcpRuntimeOptions {
  readonly config: ShoggothConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly db: Database.Database;
  readonly deps?: {
    readonly connectShoggothMcpServers?: typeof connectShoggothMcpServers;
  };
}

export interface SessionMcpRuntime {
  readonly resolveContext: (sessionId: string) => Promise<SessionMcpToolContext>;
  /** Call when an inbound user turn starts (clears idle eviction timers for all applicable scopes). */
  readonly notifyTurnBegin: (sessionId: string) => void;
  /** Call when a turn finishes (schedules idle eviction when configured). */
  readonly notifyTurnEnd: (sessionId: string) => void;
  readonly shutdown: () => Promise<void>;
  /** True when perInstanceIdleTimeoutMs > 0 and at least one MCP server is configured. */
  readonly trackInstanceIdle: boolean;
}

function buildMcpPoolConnectOptions(env: NodeJS.ProcessEnv): ConnectShoggothMcpPoolOptions {
  const vault = vaultServiceRef.current;
  if (env.SHOGGOTH_MCP_LOG_SERVER_MESSAGES === "1") {
    const child = log.child({ component: "mcp-sse" });
    return {
      vault,
      onMcpServerMessage: ({ sourceId, msg }) => {
        child.debug("mcp.server_message", { sourceId, msg });
      },
    };
  }
  return { vault };
}

/** Default UID/GID for agent processes when no session row is available. */
const DEFAULT_AGENT_CREDS = resolveAgentCreds();

/**
 * Resolve agent MCP context (uid, gid, workspacePath) for a given agent ID.
 * Tries to look up credentials from an existing session row; falls back to defaults.
 */
function resolveAgentMcpContext(
  db: Database.Database,
  agentId: string,
  workspacesRoot: string,
): AgentMcpContext {
  const workspacePath = resolveAgentWorkspacePath(workspacesRoot, agentId);

  // Try to find uid/gid from an existing session for this agent
  let uid = DEFAULT_AGENT_CREDS.uid;
  let gid = DEFAULT_AGENT_CREDS.gid;
  try {
    const row = db
      .prepare(
        `SELECT runtime_uid, runtime_gid FROM sessions WHERE id LIKE @pattern AND runtime_uid IS NOT NULL LIMIT 1`,
      )
      .get({ pattern: `agent:${agentId}:%` }) as
      | { runtime_uid: number | null; runtime_gid: number | null }
      | undefined;
    if (row?.runtime_uid != null) uid = row.runtime_uid;
    if (row?.runtime_gid != null) gid = row.runtime_gid;
  } catch {
    // DB lookup failed — use defaults
  }

  return { uid, gid, workspacePath };
}

/**
 * Owns MCP connection pools (global, per-agent, and/or per-session), cancel-handler registration,
 * and idle eviction — independent of any specific message platform.
 */
export async function createSessionMcpRuntime(
  opts: CreateSessionMcpRuntimeOptions,
): Promise<SessionMcpRuntime> {
  // Snapshot and drain pending finalizers so each runtime gets its own copy.
  const finalizers: SessionMcpContextFinalizer[] = [...pendingFinalizers];
  pendingFinalizers.length = 0;

  function runContextFinalizers(
    ctx: SessionMcpToolContext,
    sessionId: string,
  ): SessionMcpToolContext {
    return finalizers.reduce((c, fn) => fn(c, sessionId), ctx);
  }

  // Register MCP server rules finalizer.
  finalizers.push(createMcpServerRulesFinalizer(opts.config));
  // Register context-level tool filtering finalizer (config-aware).
  finalizers.push(createContextLevelToolFinalizer(opts.config));
  // Register web-search tool finalizer (adds builtin-web-search when SearXNG is configured).
  finalizers.push(createWebSearchToolFinalizer(opts.config));
  // Register media-generate tool finalizer (adds builtin-media-generate when a gemini provider exists).
  finalizers.push(createMediaGenerateToolFinalizer(opts.config));
  // Register vault tool finalizer (adds builtin-vault when vault service is initialized).
  finalizers.push(createVaultToolFinalizer());
  // Register elevation tool finalizer (conditionally injects builtin-elevate when grant is active).
  finalizers.push(createElevationToolFinalizer(opts.db));
  // Register skills enum finalizer (enriches builtin-skills id field with available skill IDs).
  finalizers.push((ctx, sessionId) => {
    const skillsTool = ctx.aggregated.tools.find((t) => t.namespacedName === "builtin-skills");
    if (!skillsTool) return ctx;

    const parsed = parseAgentSessionUrn(sessionId);
    const workspacesRoot = opts.config.workspacesRoot ?? LAYOUT.workspacesRoot;
    const workspacePath = parsed ? resolve(workspacesRoot, parsed.agentId) : undefined;
    const skills = listSkillsForConfig(opts.config, workspacePath);
    const ids = skills.filter((s) => s.enabled).map((s) => s.id);
    if (ids.length === 0) return ctx;

    const inputSchema = JSON.parse(JSON.stringify(skillsTool.inputSchema));
    if (inputSchema.properties?.id) {
      inputSchema.properties.id.enum = ids;
    }

    const updatedTools = ctx.aggregated.tools.map((t) =>
      t.namespacedName === "builtin-skills" ? { ...t, inputSchema } : t,
    );

    const aggregated = createAggregateMcpCatalogResult(updatedTools);
    return {
      ...ctx,
      aggregated,
      toolsOpenAi: ctx.toolsOpenAi.map((t) =>
        t.function.name === "builtin-skills"
          ? { ...t, function: { ...t.function, parameters: inputSchema } }
          : t,
      ),
      toolsLoop: ctx.toolsLoop.map((t) =>
        t.name === "builtin-skills" ? { ...t, inputSchema } : t,
      ),
    };
  });

  // Register service tool finalizer (injects tools from plugin services).
  finalizers.push(createServiceToolFinalizer());

  // Register tool discovery finalizer (must be last — sees the full catalog including web-search).
  finalizers.push(createToolDiscoveryFinalizer(opts.config, opts.db));

  const mcpServers = opts.config.mcp?.servers ?? [];
  const mcpPoolScope = opts.config.mcp?.poolScope ?? "global";
  const connectMcpPool = opts.deps?.connectShoggothMcpServers ?? connectShoggothMcpServers;
  const builtinMcpCtx = buildBuiltinOnlySessionMcpToolContext();
  // Bumped whenever a pool re-fetches a source's tool catalog in place
  // (notifications/tools/list_changed). Cached contexts snapshot their catalogs,
  // so they compare against this generation on resolveContext and rebuild lazily.
  let catalogEpoch = 0;
  const mcpConnectOpts: ConnectShoggothMcpPoolOptions = {
    ...buildMcpPoolConnectOptions(opts.env),
    onToolCatalogChange: () => {
      catalogEpoch += 1;
    },
  };
  const workspacesRoot = opts.config.workspacesRoot ?? LAYOUT.workspacesRoot;

  const { globalServers, perAgentServers, perSessionServers } = partitionMcpServersByEffectiveScope(
    mcpServers,
    mcpPoolScope,
  );
  const globalSourceIds = new Set(globalServers.map((s) => s.id));
  const perAgentSourceIds = new Set(perAgentServers.map((s) => s.id));
  const perSessionSourceIds = new Set(perSessionServers.map((s) => s.id));

  // ── Global pool state (mutable for idle eviction / reconnect) ──
  let globalExternalSources: readonly McpSourceCatalog[] = [];
  let globalExternalInvoke: ExternalMcpInvoke | undefined;
  let mcpShutdownGlobal: (() => Promise<void>) | undefined;
  let globalPoolConnected = false;
  /**
   * The last global connect attempt failed (per-server circuits are open).
   * While set, resolveContext does not re-trigger a connect — re-running the
   * whole retry budget on every tool resolution would be a churn loop.
   */
  let globalConnectFailed = false;
  /**
   * The pending global reconnect is explicit (idle eviction tore down a
   * previously connected pool) — re-arm the circuit breakers for it.
   */
  let globalReconnectReArm = false;

  /** Connect (or reconnect) the global MCP pool. */
  async function connectGlobalPool(rearmCircuits: boolean): Promise<void> {
    if (globalServers.length === 0) return;
    try {
      const { pool, external, statuses } = await connectMcpPool(globalServers, {
        ...mcpConnectOpts,
        rearmCircuits,
      });
      logMcpConnectStatuses(statuses, { poolScope: "global" });
      const unregisterGlobal = registerMcpHttpCancelHandler(
        SHOGGOTH_GLOBAL_MCP_SESSION_KEY,
        (sourceId, requestId) => pool.cancelMcpRequest?.(sourceId, requestId) ?? false,
      );
      mcpShutdownGlobal = async () => {
        unregisterGlobal();
        await pool.close();
      };
      globalExternalSources = pool.externalSources;
      globalExternalInvoke = external;
      globalPoolConnected = true;
      globalConnectFailed = false;
    } catch (e) {
      globalConnectFailed = true;
      log.error("session.mcp_pool.connect_failed", { err: String(e) });
    }
  }

  // Initial global pool connect (explicit — re-arms circuits so a fresh
  // daemon boot always gets a full retry budget).
  await connectGlobalPool(true);

  // Pre-built context when only global servers exist (no per-agent, no per-session).
  function buildGlobalOnlyCtx(): SessionMcpToolContext {
    if (perSessionServers.length === 0 && perAgentServers.length === 0) {
      return buildMixedSessionMcpToolContext(
        globalExternalSources,
        globalExternalInvoke,
        [],
        undefined,
        globalSourceIds,
        perSessionSourceIds,
      );
    }
    return builtinMcpCtx;
  }

  let globalOnlyMcpCtx = buildGlobalOnlyCtx();
  let globalOnlyMcpCtxEpoch = catalogEpoch;

  // ── Per-session pool state ───────────────────────────────────────
  const perSessionMcpClose = new Map<string, () => Promise<void>>();
  /**
   * A per-session context is a snapshot of aggregated tools. `rebuild` re-derives
   * it from the live pool catalogs (arrays mutated in place on refresh), and
   * `epoch` records the catalog generation it was built at — so when
   * `onToolCatalogChange` bumps `catalogEpoch`, the next resolveContext rebuilds
   * and serves the refreshed tool list without reconnecting.
   */
  type PerSessionMcpCacheEntry = {
    ctx: SessionMcpToolContext;
    rebuild: () => SessionMcpToolContext;
    epoch: number;
  };
  const perSessionMcpCtx = new Map<string, PerSessionMcpCacheEntry>();
  const perSessionMcpConnect = new Map<string, Promise<SessionMcpToolContext>>();

  // ── Per-session cache size limit ─────────────────────────────────
  const MAX_SESSION_MCP_CACHE_SIZE = 50;
  const perSessionCacheOrder: string[] = [];

  /** Track a per-session cache entry and evict the oldest when over limit. */
  function trackSessionCacheEntry(sessionId: string): void {
    // Avoid duplicates in the order array.
    const existingIdx = perSessionCacheOrder.indexOf(sessionId);
    if (existingIdx !== -1) {
      perSessionCacheOrder.splice(existingIdx, 1);
    }
    perSessionCacheOrder.push(sessionId);

    // Evict oldest entries when over the limit.
    while (perSessionCacheOrder.length > MAX_SESSION_MCP_CACHE_SIZE) {
      const oldest = perSessionCacheOrder.shift()!;
      evictPool(oldest, "per_session");
    }
  }

  // ── Per-agent pool state ─────────────────────────────────────────
  const perAgentMcpClose = new Map<string, () => Promise<void>>();
  const perAgentMcpCtx = new Map<
    string,
    { sources: readonly McpSourceCatalog[]; external: ExternalMcpInvoke | undefined }
  >();
  const perAgentMcpConnect = new Map<
    string,
    Promise<{ sources: readonly McpSourceCatalog[]; external: ExternalMcpInvoke | undefined }>
  >();

  // ── Unified idle eviction ────────────────────────────────────────

  function resolveInstanceIdleMs(): number {
    const v = opts.config.mcp?.perInstanceIdleTimeoutMs;
    if (v === 0) return 0;
    if (v === undefined) return SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS;
    return v;
  }

  const instanceIdleMs = resolveInstanceIdleMs();
  const trackInstanceIdle = mcpServers.length > 0 && instanceIdleMs > 0;

  // Three timer stores — one per pool scope.
  const globalIdleTimer: { ref?: ReturnType<typeof setTimeout> } = {};
  const perAgentIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const perSessionIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelIdleEviction(key: string, scope: "global" | "per_agent" | "per_session"): void {
    if (scope === "global") {
      if (globalIdleTimer.ref !== undefined) {
        clearTimeout(globalIdleTimer.ref);
        globalIdleTimer.ref = undefined;
      }
    } else if (scope === "per_agent") {
      const t = perAgentIdleTimers.get(key);
      if (t !== undefined) {
        clearTimeout(t);
        perAgentIdleTimers.delete(key);
      }
    } else {
      const t = perSessionIdleTimers.get(key);
      if (t !== undefined) {
        clearTimeout(t);
        perSessionIdleTimers.delete(key);
      }
    }
  }

  function evictPool(key: string, scope: "global" | "per_agent" | "per_session"): void {
    cancelIdleEviction(key, scope);
    log.info("session.mcp_pool.idle_evicted", { key, scope });

    if (scope === "global") {
      // Close the global pool; next resolveContext will reconnect.
      if (mcpShutdownGlobal) {
        const shutdownFn = mcpShutdownGlobal;
        // Optimistically clear state so resolveContext triggers a reconnect.
        // The reconnect is explicit (eviction of a live pool): re-arm circuits.
        mcpShutdownGlobal = undefined;
        globalExternalSources = [];
        globalExternalInvoke = undefined;
        globalPoolConnected = false;
        globalConnectFailed = false;
        globalReconnectReArm = true;
        globalOnlyMcpCtx = buildGlobalOnlyCtx();
        globalOnlyMcpCtxEpoch = catalogEpoch;
        void shutdownFn().catch((err) => {
          log.error("session.mcp_pool.eviction_close_failed", {
            key,
            scope,
            error: String(err),
          });
          // Close failed (EPERM) — restore state so we don't spawn a duplicate.
          mcpShutdownGlobal = shutdownFn;
          globalPoolConnected = true;
        });
      }
    } else if (scope === "per_agent") {
      const close = perAgentMcpClose.get(key);
      if (close) {
        // Optimistically clear state.
        perAgentMcpClose.delete(key);
        perAgentMcpCtx.delete(key);
        void close().catch((err) => {
          log.error("session.mcp_pool.eviction_close_failed", {
            key,
            scope,
            error: String(err),
          });
          // Close failed — restore state so we don't spawn a duplicate.
          perAgentMcpClose.set(key, close);
        });
      }
    } else {
      const close = perSessionMcpClose.get(key);
      if (close) {
        // Optimistically clear state.
        perSessionMcpClose.delete(key);
        perSessionMcpCtx.delete(key);
        const cacheIdx = perSessionCacheOrder.indexOf(key);
        if (cacheIdx !== -1) perSessionCacheOrder.splice(cacheIdx, 1);
        void close().catch((err) => {
          log.error("session.mcp_pool.eviction_close_failed", {
            key,
            scope,
            error: String(err),
          });
          // Close failed — restore state so we don't spawn a duplicate.
          perSessionMcpClose.set(key, close);
        });
      }
    }
  }

  function scheduleIdleEviction(key: string, scope: "global" | "per_agent" | "per_session"): void {
    cancelIdleEviction(key, scope);
    const t = setTimeout(() => {
      if (scope === "global") {
        globalIdleTimer.ref = undefined;
      } else if (scope === "per_agent") {
        perAgentIdleTimers.delete(key);
      } else {
        perSessionIdleTimers.delete(key);
      }
      evictPool(key, scope);
    }, instanceIdleMs);

    if (scope === "global") {
      globalIdleTimer.ref = t;
    } else if (scope === "per_agent") {
      perAgentIdleTimers.set(key, t);
    } else {
      perSessionIdleTimers.set(key, t);
    }
  }

  // ── Per-agent pool helpers ───────────────────────────────────────

  /**
   * Ensures a per-agent MCP pool is connected for `agentId`, returning cached sources/external.
   * Concurrent calls for the same agent coalesce on a single in-flight promise.
   */
  async function ensurePerAgentPool(
    agentId: string,
  ): Promise<{ sources: readonly McpSourceCatalog[]; external: ExternalMcpInvoke | undefined }> {
    const cached = perAgentMcpCtx.get(agentId);
    if (cached) return cached;

    let inflight = perAgentMcpConnect.get(agentId);
    if (!inflight) {
      inflight = (async () => {
        try {
          const agentContext = resolveAgentMcpContext(opts.db, agentId, workspacesRoot);
          const connectOpts: ConnectShoggothMcpPoolOptions = {
            ...mcpConnectOpts,
            agentContext,
            agentId,
          };
          // Filter out servers denied for this agent in any context (top-level
          // or subagent). If a server is denied in ANY context, it should not
          // be started in the shared per-agent pool.
          const topRules = resolveEffectiveMcpServerRules(opts.config, agentId, false);
          const subRules = resolveEffectiveMcpServerRules(opts.config, agentId, true);
          const allowedServers = perAgentServers.filter(
            (s) => evaluateMcpServerRules(s.id, topRules) && evaluateMcpServerRules(s.id, subRules),
          );
          const { pool, external, statuses } = await connectMcpPool(allowedServers, connectOpts);
          logMcpConnectStatuses(statuses, { poolScope: "per_agent", agentId });
          const cancelKey = mcpAgentPoolKey(agentId);
          const unregister = registerMcpHttpCancelHandler(
            cancelKey,
            (sourceId, requestId) => pool.cancelMcpRequest?.(sourceId, requestId) ?? false,
          );
          perAgentMcpClose.set(agentId, async () => {
            unregister();
            await pool.close();
          });
          const result = { sources: pool.externalSources, external };
          perAgentMcpCtx.set(agentId, result);
          return result;
        } catch (e) {
          log.error("session.mcp_pool.per_agent_connect_failed", {
            err: String(e),
            agentId,
          });
          const empty = { sources: [] as McpSourceCatalog[], external: undefined };
          perAgentMcpCtx.set(agentId, empty);
          return empty;
        }
      })();
      perAgentMcpConnect.set(agentId, inflight);
      void inflight.finally(() => {
        perAgentMcpConnect.delete(agentId);
      });
    }
    return inflight;
  }

  // ── resolveContext ───────────────────────────────────────────────

  async function resolveContext(sessionId: string): Promise<SessionMcpToolContext> {
    if (mcpServers.length === 0) {
      return runContextFinalizers(builtinMcpCtx, sessionId);
    }

    // Reconnect the global pool when it is not connected: after an explicit
    // idle eviction (re-arms the circuit breakers), or after a failed connect
    // only when some server's breaker has closed meanwhile. A failed connect
    // with all circuits open is NOT retried here — that would re-run the
    // retry budget on every resolveContext.
    if (
      globalServers.length > 0 &&
      !globalPoolConnected &&
      (!globalConnectFailed || globalReconnectReArm)
    ) {
      await connectGlobalPool(globalReconnectReArm);
      globalReconnectReArm = false;
      globalOnlyMcpCtx = buildGlobalOnlyCtx();
      globalOnlyMcpCtxEpoch = catalogEpoch;
    }

    // Fast path: only global servers, no per-agent or per-session.
    if (perSessionServers.length === 0 && perAgentServers.length === 0) {
      if (globalOnlyMcpCtxEpoch !== catalogEpoch) {
        // A pool refreshed a catalog in place — rebuild the snapshot so the
        // next resolveContext serves the current tool list.
        globalOnlyMcpCtx = buildGlobalOnlyCtx();
        globalOnlyMcpCtxEpoch = catalogEpoch;
      }
      return runContextFinalizers(globalOnlyMcpCtx, sessionId);
    }

    // Extract agent ID from session URN (needed for per-agent pool keying).
    const parsed = parseAgentSessionUrn(sessionId);
    const agentId = parsed?.agentId ?? null;
    const isSubagent = isSubagentSessionUrn(sessionId);

    // ── Resolve per-agent pool (if applicable) ──────────────────
    let agentSources: readonly McpSourceCatalog[] = [];
    let agentExternal: ExternalMcpInvoke | undefined;

    if (perAgentServers.length > 0 && agentId) {
      const agentPool = await ensurePerAgentPool(agentId);
      agentSources = agentPool.sources;
      agentExternal = agentPool.external;
    }

    // ── No per-session servers: merge global + per-agent ────────
    if (perSessionServers.length === 0) {
      const ctx = buildMixedSessionMcpToolContext(
        globalExternalSources,
        globalExternalInvoke,
        agentSources,
        agentExternal,
        globalSourceIds,
        perAgentSourceIds,
      );
      return runContextFinalizers(ctx, sessionId);
    }

    // ── Per-session servers present: need per-session pool too ──
    // Check per-session cache first.
    const cachedSession = perSessionMcpCtx.get(sessionId);
    if (cachedSession) {
      if (cachedSession.epoch !== catalogEpoch) {
        // Catalog generation moved (a pool refreshed tools/list in place) —
        // rebuild the snapshot from the live pool arrays; no reconnect happens.
        cachedSession.ctx = cachedSession.rebuild();
        cachedSession.epoch = catalogEpoch;
      }
      return runContextFinalizers(cachedSession.ctx, sessionId);
    }

    let inflight = perSessionMcpConnect.get(sessionId);
    if (!inflight) {
      inflight = (async () => {
        try {
          // When the session belongs to a known agent, run per-session MCP
          // servers under that agent's identity (uid/gid/workspacePath).
          const perSessionConnectOpts: ConnectShoggothMcpPoolOptions = agentId
            ? {
                ...mcpConnectOpts,
                agentContext: resolveAgentMcpContext(opts.db, agentId, workspacesRoot),
                agentId,
              }
            : { ...mcpConnectOpts };
          // Filter out servers denied by effective rules for this session.
          const sessionRules = resolveEffectiveMcpServerRules(
            opts.config,
            agentId ?? "",
            isSubagent,
          );
          const allowedPerSessionServers = perSessionServers.filter((s) =>
            evaluateMcpServerRules(s.id, sessionRules),
          );
          const { pool, external, statuses } = await connectMcpPool(
            allowedPerSessionServers,
            perSessionConnectOpts,
          );
          logMcpConnectStatuses(statuses, { poolScope: "per_session", sessionId });
          const unregister = registerMcpHttpCancelHandler(
            sessionId,
            (sourceId, requestId) => pool.cancelMcpRequest?.(sourceId, requestId) ?? false,
          );
          perSessionMcpClose.set(sessionId, async () => {
            unregister();
            await pool.close();
          });

          // Closure reads the live pool arrays (mutated in place on catalog
          // refresh) so the cached entry can be rebuilt without reconnecting.
          const buildCtx = (): SessionMcpToolContext => {
            if (globalServers.length === 0 && agentSources.length === 0) {
              // Only per-session sources.
              return buildSessionMcpToolContext(pool.externalSources, external);
            }
            if (agentSources.length > 0) {
              // Three-tier: global + per-agent + per-session.
              return buildThreeTierSessionMcpToolContext(
                globalExternalSources,
                globalExternalInvoke,
                agentSources,
                agentExternal,
                pool.externalSources,
                external,
                globalSourceIds,
                perAgentSourceIds,
                perSessionSourceIds,
              );
            }
            // Two-tier: global + per-session.
            return buildMixedSessionMcpToolContext(
              globalExternalSources,
              globalExternalInvoke,
              pool.externalSources,
              external,
              globalSourceIds,
              perSessionSourceIds,
            );
          };
          const ctx = buildCtx();
          perSessionMcpCtx.set(sessionId, { ctx, rebuild: buildCtx, epoch: catalogEpoch });
          trackSessionCacheEntry(sessionId);
          return ctx;
        } catch (e) {
          log.error("session.mcp_pool.connect_failed", {
            err: String(e),
            sessionId,
          });
          // Fallback: global + per-agent (no per-session). Same rebuild contract
          // as the success path — reads live arrays, snapshots on catalog epoch.
          const buildFallback = (): SessionMcpToolContext => {
            if (agentSources.length > 0) {
              return buildMixedSessionMcpToolContext(
                globalExternalSources,
                globalExternalInvoke,
                agentSources,
                agentExternal,
                globalSourceIds,
                perAgentSourceIds,
              );
            }
            return buildMixedSessionMcpToolContext(
              globalExternalSources,
              globalExternalInvoke,
              [],
              undefined,
              globalSourceIds,
              perSessionSourceIds,
            );
          };
          const fallback = buildFallback();
          perSessionMcpCtx.set(sessionId, {
            ctx: fallback,
            rebuild: buildFallback,
            epoch: catalogEpoch,
          });
          trackSessionCacheEntry(sessionId);
          return fallback;
        }
      })();
      perSessionMcpConnect.set(sessionId, inflight);
      void inflight.finally(() => {
        perSessionMcpConnect.delete(sessionId);
      });
    }
    return runContextFinalizers(await inflight, sessionId);
  }

  // ── notifyTurnBegin / notifyTurnEnd ──────────────────────────────

  function notifyTurnBegin(sessionId: string): void {
    if (!trackInstanceIdle) return;
    const parsed = parseAgentSessionUrn(sessionId);
    const agentId = parsed?.agentId ?? null;

    cancelIdleEviction("__global__", "global");
    if (agentId) cancelIdleEviction(agentId, "per_agent");
    cancelIdleEviction(sessionId, "per_session");
  }

  function notifyTurnEnd(sessionId: string): void {
    if (!trackInstanceIdle) return;
    const parsed = parseAgentSessionUrn(sessionId);
    const agentId = parsed?.agentId ?? null;

    if (globalServers.length > 0 && globalPoolConnected) {
      scheduleIdleEviction("__global__", "global");
    }
    if (agentId && perAgentMcpCtx.has(agentId)) {
      scheduleIdleEviction(agentId, "per_agent");
    }
    if (perSessionMcpClose.has(sessionId)) {
      scheduleIdleEviction(sessionId, "per_session");
    }
  }

  const _runtime: SessionMcpRuntime = {
    resolveContext,
    notifyTurnBegin,
    notifyTurnEnd,
    trackInstanceIdle,
    shutdown: async () => {
      // Clear all idle timers.
      if (globalIdleTimer.ref !== undefined) {
        clearTimeout(globalIdleTimer.ref);
        globalIdleTimer.ref = undefined;
      }
      for (const t of perAgentIdleTimers.values()) {
        clearTimeout(t);
      }
      perAgentIdleTimers.clear();
      for (const t of perSessionIdleTimers.values()) {
        clearTimeout(t);
      }
      perSessionIdleTimers.clear();

      if (mcpShutdownGlobal) {
        await mcpShutdownGlobal();
      }
      // Close all per-agent pools.
      await Promise.all([...perAgentMcpClose.values()].map((fn) => fn().catch(() => {})));
      perAgentMcpClose.clear();
      perAgentMcpCtx.clear();
      perAgentMcpConnect.clear();
      // Close all per-session pools.
      await Promise.all([...perSessionMcpClose.values()].map((fn) => fn().catch(() => {})));
      perSessionMcpClose.clear();
      perSessionMcpCtx.clear();
      perSessionMcpConnect.clear();
      perSessionCacheOrder.length = 0;
      finalizers.length = 0;
    },
  };
  _runtimeRef = _runtime;
  return _runtime;
}

// ── Singleton ref ──────────────────────────────────────────────────
let _runtimeRef: SessionMcpRuntime | undefined;

/** Returns the last created SessionMcpRuntime, or undefined. */
export function getSessionMcpRuntimeRef(): SessionMcpRuntime | undefined {
  return _runtimeRef;
}
