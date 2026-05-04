import type { McpSourceCatalog } from "@shoggoth/mcp-integration";
import type Database from "better-sqlite3";
import { SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS, type ShoggothConfig } from "@shoggoth/shared";
import { getLogger } from "../logging";
import {
  connectShoggothMcpServers,
  partitionMcpServersByEffectiveScope,
  type AgentMcpContext,
  type ConnectShoggothMcpPoolOptions,
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
  createWebSearchToolFinalizer,
  type SessionMcpToolContext,
} from "./session-mcp-tool-context";
import { listSkillsForConfig } from "@shoggoth/skills";
import { parseAgentSessionUrn, resolveAgentWorkspacePath, LAYOUT } from "@shoggoth/shared";
import { resolve } from "node:path";
import { createToolDiscoveryFinalizer } from "./session-tool-discovery";
import { createElevationToolFinalizer } from "./elevation-tool-finalizer";

const log = getLogger("session-mcp");

export type SessionMcpContextFinalizer = (
  ctx: SessionMcpToolContext,
  sessionId: string,
) => SessionMcpToolContext;

const contextFinalizers: SessionMcpContextFinalizer[] = [];

export function registerContextFinalizer(fn: SessionMcpContextFinalizer): void {
  contextFinalizers.push(fn);
}

function runContextFinalizers(
  ctx: SessionMcpToolContext,
  sessionId: string,
): SessionMcpToolContext {
  return contextFinalizers.reduce((c, fn) => fn(c, sessionId), ctx);
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
  /** Call when an inbound user turn starts (clears per-session idle eviction timer). */
  readonly notifyTurnBegin: (sessionId: string) => void;
  /** Call when a turn finishes (schedules idle eviction when configured). */
  readonly notifyTurnEnd: (sessionId: string) => void;
  readonly shutdown: () => Promise<void>;
  readonly trackPerSessionIdle: boolean;
}

function buildMcpPoolConnectOptions(
  env: NodeJS.ProcessEnv,
): ConnectShoggothMcpPoolOptions | undefined {
  if (env.SHOGGOTH_MCP_LOG_SERVER_MESSAGES !== "1") return undefined;
  const child = log.child({ component: "mcp-sse" });
  return {
    onMcpServerMessage: ({ sourceId, msg }) => {
      child.debug("mcp.server_message", { sourceId, msg });
    },
  };
}

/** Default UID/GID for agent processes when no session row is available. */
const DEFAULT_AGENT_UID = 900;
const DEFAULT_AGENT_GID = 900;

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
  let uid = DEFAULT_AGENT_UID;
  let gid = DEFAULT_AGENT_GID;
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
  // Register MCP server rules finalizer.
  registerContextFinalizer(createMcpServerRulesFinalizer(opts.config));
  // Register context-level tool filtering finalizer (config-aware).
  registerContextFinalizer(createContextLevelToolFinalizer(opts.config));
  // Register web-search tool finalizer (adds builtin-web-search when SearXNG is configured).
  registerContextFinalizer(createWebSearchToolFinalizer(opts.config));
  // Register media-generate tool finalizer (adds builtin-media-generate when a gemini provider exists).
  registerContextFinalizer(createMediaGenerateToolFinalizer(opts.config));
  // Register elevation tool finalizer (conditionally injects builtin-elevate when grant is active).
  registerContextFinalizer(createElevationToolFinalizer(opts.db));
  // Register skills enum finalizer (enriches builtin-skills id field with available skill IDs).
  registerContextFinalizer((ctx, sessionId) => {
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

    const aggregated = { ...ctx.aggregated, tools: updatedTools };
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

  // Register tool discovery finalizer (must be last — sees the full catalog including web-search).
  registerContextFinalizer(createToolDiscoveryFinalizer(opts.config, opts.db));

  const mcpServers = opts.config.mcp?.servers ?? [];
  const mcpPoolScope = opts.config.mcp?.poolScope ?? "global";
  const connectMcpPool = opts.deps?.connectShoggothMcpServers ?? connectShoggothMcpServers;
  const builtinMcpCtx = buildBuiltinOnlySessionMcpToolContext();
  const mcpConnectOpts = buildMcpPoolConnectOptions(opts.env);
  const workspacesRoot = opts.config.workspacesRoot ?? LAYOUT.workspacesRoot;

  const { globalServers, perAgentServers, perSessionServers } = partitionMcpServersByEffectiveScope(
    mcpServers,
    mcpPoolScope,
  );
  const globalSourceIds = new Set(globalServers.map((s) => s.id));
  const perAgentSourceIds = new Set(perAgentServers.map((s) => s.id));
  const perSessionSourceIds = new Set(perSessionServers.map((s) => s.id));

  let globalExternalSources: readonly McpSourceCatalog[] = [];
  let globalExternalInvoke: ExternalMcpInvoke | undefined;
  let mcpShutdownGlobal: (() => Promise<void>) | undefined;

  if (globalServers.length > 0) {
    try {
      const { pool, external } = await connectMcpPool(globalServers, mcpConnectOpts);
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
    } catch (e) {
      log.error("session.mcp_pool.connect_failed", { err: String(e) });
    }
  }

  // Pre-built context when only global servers exist (no per-agent, no per-session).
  const globalOnlyMcpCtx =
    perSessionServers.length === 0 && perAgentServers.length === 0
      ? buildMixedSessionMcpToolContext(
          globalExternalSources,
          globalExternalInvoke,
          [],
          undefined,
          globalSourceIds,
          perSessionSourceIds,
        )
      : builtinMcpCtx;

  // ── Per-session pool state ───────────────────────────────────────
  const perSessionMcpClose = new Map<string, () => Promise<void>>();
  const perSessionMcpCtx = new Map<string, SessionMcpToolContext>();
  const perSessionMcpConnect = new Map<string, Promise<SessionMcpToolContext>>();
  const perSessionMcpIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  function resolvePerSessionMcpIdleMs(): number {
    if (perSessionServers.length === 0) return 0;
    const v = opts.config.mcp?.perInstanceIdleTimeoutMs;
    if (v === 0) return 0;
    if (v === undefined) return SHOGGOTH_DEFAULT_MCP_INSTANCE_IDLE_MS;
    return v;
  }

  const perSessionMcpIdleMs = resolvePerSessionMcpIdleMs();
  const trackPerSessionIdle =
    mcpServers.length > 0 && perSessionMcpIdleMs > 0 && perSessionServers.length > 0;

  function cancelPerSessionMcpIdleTimer(sessionId: string): void {
    const t = perSessionMcpIdleTimers.get(sessionId);
    if (t !== undefined) {
      clearTimeout(t);
      perSessionMcpIdleTimers.delete(sessionId);
    }
  }

  function evictPerSessionMcpIdlePool(sessionId: string): void {
    cancelPerSessionMcpIdleTimer(sessionId);
    const close = perSessionMcpClose.get(sessionId);
    if (close) {
      void close().catch(() => {});
      perSessionMcpClose.delete(sessionId);
    }
    perSessionMcpCtx.delete(sessionId);
  }

  function schedulePerSessionMcpIdleTimer(sessionId: string): void {
    cancelPerSessionMcpIdleTimer(sessionId);
    const t = setTimeout(() => {
      perSessionMcpIdleTimers.delete(sessionId);
      log.info("session.mcp_pool.idle_evicted", { sessionId });
      evictPerSessionMcpIdlePool(sessionId);
    }, perSessionMcpIdleMs);
    perSessionMcpIdleTimers.set(sessionId, t);
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
          };
          const { pool, external } = await connectMcpPool(perAgentServers, connectOpts);
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

    // Fast path: only global servers, no per-agent or per-session.
    if (perSessionServers.length === 0 && perAgentServers.length === 0) {
      return runContextFinalizers(globalOnlyMcpCtx, sessionId);
    }

    // Extract agent ID from session URN (needed for per-agent pool keying).
    const parsed = parseAgentSessionUrn(sessionId);
    const agentId = parsed?.agentId ?? null;

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
      return runContextFinalizers(cachedSession, sessionId);
    }

    let inflight = perSessionMcpConnect.get(sessionId);
    if (!inflight) {
      inflight = (async () => {
        try {
          const { pool, external } = await connectMcpPool(perSessionServers, mcpConnectOpts);
          const unregister = registerMcpHttpCancelHandler(
            sessionId,
            (sourceId, requestId) => pool.cancelMcpRequest?.(sourceId, requestId) ?? false,
          );
          perSessionMcpClose.set(sessionId, async () => {
            unregister();
            await pool.close();
          });

          let ctx: SessionMcpToolContext;
          if (globalServers.length === 0 && agentSources.length === 0) {
            // Only per-session sources.
            ctx = buildSessionMcpToolContext(pool.externalSources, external);
          } else if (agentSources.length > 0) {
            // Three-tier: global + per-agent + per-session.
            ctx = buildThreeTierSessionMcpToolContext(
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
          } else {
            // Two-tier: global + per-session.
            ctx = buildMixedSessionMcpToolContext(
              globalExternalSources,
              globalExternalInvoke,
              pool.externalSources,
              external,
              globalSourceIds,
              perSessionSourceIds,
            );
          }
          perSessionMcpCtx.set(sessionId, ctx);
          return ctx;
        } catch (e) {
          log.error("session.mcp_pool.connect_failed", {
            err: String(e),
            sessionId,
          });
          // Fallback: global + per-agent (no per-session).
          let fallback: SessionMcpToolContext;
          if (agentSources.length > 0) {
            fallback = buildMixedSessionMcpToolContext(
              globalExternalSources,
              globalExternalInvoke,
              agentSources,
              agentExternal,
              globalSourceIds,
              perAgentSourceIds,
            );
          } else {
            fallback = buildMixedSessionMcpToolContext(
              globalExternalSources,
              globalExternalInvoke,
              [],
              undefined,
              globalSourceIds,
              perSessionSourceIds,
            );
          }
          perSessionMcpCtx.set(sessionId, fallback);
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

  const _runtime: SessionMcpRuntime = {
    resolveContext,
    notifyTurnBegin: cancelPerSessionMcpIdleTimer,
    notifyTurnEnd: (sessionId: string) => {
      if (trackPerSessionIdle) {
        schedulePerSessionMcpIdleTimer(sessionId);
      }
    },
    trackPerSessionIdle,
    shutdown: async () => {
      for (const t of perSessionMcpIdleTimers.values()) {
        clearTimeout(t);
      }
      perSessionMcpIdleTimers.clear();
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
      contextFinalizers.length = 0;
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
