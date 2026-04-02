import type { McpSourceCatalog } from "@shoggoth/mcp-integration";
import {
  SHOGGOTH_DEFAULT_PER_SESSION_MCP_IDLE_MS,
  type ShoggothConfig,
} from "@shoggoth/shared";
import { getLogger } from "../logging";
import {
  connectShoggothMcpServers,
  partitionMcpServersByEffectiveScope,
  type ConnectShoggothMcpPoolOptions,
} from "../mcp/mcp-server-pool";
import {
  registerMcpHttpCancelHandler,
  SHOGGOTH_GLOBAL_MCP_SESSION_KEY,
} from "../mcp/mcp-http-cancel-registry";
import type { ExternalMcpInvoke } from "../mcp/tool-loop-mcp";
import {
  buildBuiltinOnlySessionMcpToolContext,
  buildMixedSessionMcpToolContext,
  buildSessionMcpToolContext,
  type SessionMcpToolContext,
} from "./session-mcp-tool-context";

const log = getLogger("session-mcp");

export type SessionMcpContextFinalizer = (ctx: SessionMcpToolContext, sessionId: string) => SessionMcpToolContext;

const contextFinalizers: SessionMcpContextFinalizer[] = [];

export function registerContextFinalizer(fn: SessionMcpContextFinalizer): void {
  contextFinalizers.push(fn);
}

function runContextFinalizers(ctx: SessionMcpToolContext, sessionId: string): SessionMcpToolContext {
  return contextFinalizers.reduce((c, fn) => fn(c, sessionId), ctx);
}

export interface CreateSessionMcpRuntimeOptions {
  readonly config: ShoggothConfig;
  readonly env: NodeJS.ProcessEnv;
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

/**
 * Owns MCP connection pools (global and/or per-session), cancel-handler registration, and
 * idle eviction — independent of any specific message platform.
 */
export async function createSessionMcpRuntime(
  opts: CreateSessionMcpRuntimeOptions,
): Promise<SessionMcpRuntime> {
  const mcpServers = opts.config.mcp?.servers ?? [];
  const mcpPoolScope = opts.config.mcp?.poolScope ?? "global";
  const connectMcpPool = opts.deps?.connectShoggothMcpServers ?? connectShoggothMcpServers;
  const builtinMcpCtx = buildBuiltinOnlySessionMcpToolContext();
  const mcpConnectOpts = buildMcpPoolConnectOptions(opts.env);

  const { globalServers, perSessionServers } = partitionMcpServersByEffectiveScope(
    mcpServers,
    mcpPoolScope,
  );
  const globalSourceIds = new Set(globalServers.map((s) => s.id));
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

  const globalOnlyMcpCtx =
    perSessionServers.length === 0
      ? buildMixedSessionMcpToolContext(
          globalExternalSources,
          globalExternalInvoke,
          [],
          undefined,
          globalSourceIds,
          perSessionSourceIds,
        )
      : builtinMcpCtx;

  const perSessionMcpClose = new Map<string, () => Promise<void>>();
  const perSessionMcpCtx = new Map<string, SessionMcpToolContext>();
  const perSessionMcpConnect = new Map<string, Promise<SessionMcpToolContext>>();
  const perSessionMcpIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function resolvePerSessionMcpIdleMs(): number {
    if (perSessionServers.length === 0) return 0;
    const v = opts.config.mcp?.perSessionIdleTimeoutMs;
    if (v === 0) return 0;
    if (v === undefined) return SHOGGOTH_DEFAULT_PER_SESSION_MCP_IDLE_MS;
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

  async function resolveContext(sessionId: string): Promise<SessionMcpToolContext> {
    if (mcpServers.length === 0) {
      return runContextFinalizers(builtinMcpCtx, sessionId);
    }
    if (perSessionServers.length === 0) {
      return runContextFinalizers(globalOnlyMcpCtx, sessionId);
    }
    if (globalServers.length === 0) {
      const cached = perSessionMcpCtx.get(sessionId);
      if (cached) {
        return runContextFinalizers(cached, sessionId);
      }
      let inflight = perSessionMcpConnect.get(sessionId);
      if (!inflight) {
        inflight = (async () => {
          try {
            const { pool, external } = await connectMcpPool(perSessionServers, mcpConnectOpts);
            const unregister = registerMcpHttpCancelHandler(sessionId, (sourceId, requestId) =>
              pool.cancelMcpRequest?.(sourceId, requestId) ?? false,
            );
            perSessionMcpClose.set(sessionId, async () => {
              unregister();
              await pool.close();
            });
            const ctx = buildSessionMcpToolContext(pool.externalSources, external);
            perSessionMcpCtx.set(sessionId, ctx);
            return ctx;
          } catch (e) {
            log.error("session.mcp_pool.connect_failed", {
              err: String(e),
              sessionId,
            });
            perSessionMcpCtx.set(sessionId, builtinMcpCtx);
            return builtinMcpCtx;
          }
        })();
        perSessionMcpConnect.set(sessionId, inflight);
        void inflight.finally(() => {
          perSessionMcpConnect.delete(sessionId);
        });
      }
      return runContextFinalizers(await inflight, sessionId);
    }

    const cached = perSessionMcpCtx.get(sessionId);
    if (cached) {
      return runContextFinalizers(cached, sessionId);
    }
    let inflight = perSessionMcpConnect.get(sessionId);
    if (!inflight) {
      inflight = (async () => {
        try {
          const { pool, external } = await connectMcpPool(perSessionServers, mcpConnectOpts);
          const unregister = registerMcpHttpCancelHandler(sessionId, (sourceId, requestId) =>
            pool.cancelMcpRequest?.(sourceId, requestId) ?? false,
          );
          perSessionMcpClose.set(sessionId, async () => {
            unregister();
            await pool.close();
          });
          const ctx = buildMixedSessionMcpToolContext(
            globalExternalSources,
            globalExternalInvoke,
            pool.externalSources,
            external,
            globalSourceIds,
            perSessionSourceIds,
          );
          perSessionMcpCtx.set(sessionId, ctx);
          return ctx;
        } catch (e) {
          log.error("session.mcp_pool.connect_failed", { err: String(e), sessionId });
          const fallback = buildMixedSessionMcpToolContext(
            globalExternalSources,
            globalExternalInvoke,
            [],
            undefined,
            globalSourceIds,
            perSessionSourceIds,
          );
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

  return {
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
      await Promise.all([...perSessionMcpClose.values()].map((fn) => fn().catch(() => {})));
      perSessionMcpClose.clear();
      perSessionMcpCtx.clear();
      perSessionMcpConnect.clear();
    },
  };
}
