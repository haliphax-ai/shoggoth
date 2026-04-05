/**
 * Real daemon adapters for the workflow orchestrator.
 *
 * Each adapter wraps daemon internals (session manager, session store, messaging)
 * behind the workflow package's dependency-injection interfaces.
 */

import type {
  SpawnAdapter,
  SpawnRequest,
  PollAdapter,
  PollResult,
  KillAdapter,
  MessageAdapter,
  MessagePoster,
  NotifyAdapter,
  ToolExecutor,
} from "@shoggoth/workflow";
import type { ContextLevel } from "@shoggoth/shared";
import type { SessionManager } from "./sessions/session-manager.js";
import type { SessionStore, SessionRow } from "./sessions/session-store.js";
import type { SessionMcpRuntime } from "./sessions/session-mcp-runtime.js";
import type { BuiltinToolRegistry } from "./sessions/builtin-tool-registry.js";
import { pushSystemContext } from "./sessions/system-context-buffer";
import { getLogger } from "./logging";

const log = getLogger("workflow-adapters");

// ---------------------------------------------------------------------------
// Logger adapter: convert daemon Logger to workflow logger interface
// ---------------------------------------------------------------------------

function adaptLogger(daemonLogger: ReturnType<typeof getLogger>): { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; debug: (...args: unknown[]) => void } {
  return {
    info: (msg: unknown, fields?: unknown) => daemonLogger.info(String(msg), fields as Record<string, unknown>),
    warn: (msg: unknown, fields?: unknown) => daemonLogger.warn(String(msg), fields as Record<string, unknown>),
    debug: (msg: unknown, fields?: unknown) => daemonLogger.debug(String(msg), fields as Record<string, unknown>),
  };
}

// ---------------------------------------------------------------------------
// Completion tracking for spawned subagent turns
// ---------------------------------------------------------------------------

export type CompletionEntry =
  | { ok: true; output: string; completedAt: number }
  | { ok: false; error: string; completedAt: number };

export type CompletionMap = Map<string, CompletionEntry>;

// ---------------------------------------------------------------------------
// SpawnAdapter
// ---------------------------------------------------------------------------

export interface DaemonSpawnAdapterDeps {
  readonly sessionManager: Pick<SessionManager, "spawn">;
  readonly sessions: Pick<SessionStore, "update">;
  /**
   * Fixed parent session ID. When omitted, `req.replyTo` is used as the parent
   * (the orchestrator sets replyTo to the calling session).
   */
  readonly parentSessionId?: string;
  /** Fire-and-forget model turn runner (same signature as SubagentRuntimeExtension.runSessionModelTurn). */
  readonly runSessionModelTurn: (input: {
    readonly sessionId: string;
    readonly userContent: string;
    readonly userMetadata?: Record<string, unknown>;
    readonly systemContext?: { kind: string; summary: string; data?: Record<string, unknown>; guidance?: string };
    readonly delivery: { kind: string };
  }) => Promise<{ latestAssistantText: string; failoverMeta?: unknown }>;
  /** Abort an in-flight session turn by session ID. Uses the existing session turn abort scope. */
  readonly requestTurnAbort?: (sessionId: string) => boolean;
  /** Optional map to track completion of spawned turns. Created internally if not provided. */
  readonly completionMap?: CompletionMap;
  /** Context level for spawned workflow task sessions. Defaults to "minimal". */
  readonly contextLevel?: ContextLevel;
}

export function createDaemonSpawnAdapter(deps: DaemonSpawnAdapterDeps): SpawnAdapter & { completionMap: CompletionMap; abortTask: (sessionKey: string) => void } {
  const completionMap: CompletionMap = deps.completionMap ?? new Map();

  return {
    completionMap,
    abortTask(sessionKey: string): void {
      deps.requestTurnAbort?.(sessionKey);
    },
    async spawn(req: SpawnRequest): Promise<string> {
      const parentSessionId = deps.parentSessionId ?? req.replyTo;

      const { sessionId: childId } = deps.sessionManager.spawn({
        parentSessionId,
        contextLevel: deps.contextLevel ?? "minimal",
      });

      deps.sessions.update(childId, {
        parentSessionId,
        subagentMode: "one_shot",
      });

      // Fire off the model turn without awaiting — poll adapter tracks completion.
      pushSystemContext(childId, "Workflow task execution.");
      const turnPromise = deps.runSessionModelTurn({
        sessionId: childId,
        userContent: req.prompt,
        userMetadata: {
          workflow_task_id: req.taskId,
          subagent_one_shot: true,
          parent_session_id: parentSessionId,
          respond_to: req.replyTo,
          internal: true,
        },
        systemContext: {
          kind: "workflow.task",
          summary: "You are executing a workflow task.",
          guidance: "Execute the task described in the message content. Focus only on this task and return your result.",
          data: { workflow_id: req.workflowId ?? null, task_id: req.taskId },
        },
        delivery: { kind: "internal" },
      });

      turnPromise
        .then((result) => {
          completionMap.set(childId, { ok: true, output: result.latestAssistantText, completedAt: Date.now() });
          log.debug("task turn completed", { sessionId: childId, taskId: req.taskId, outputLen: result.latestAssistantText?.length ?? 0 });
        })
        .catch((err) => {
          completionMap.set(childId, { ok: false, error: String(err), completedAt: Date.now() });
          log.error("task turn failed", { sessionId: childId, taskId: req.taskId, error: String(err) });
        });

      return childId;
    },
  };
}

// ---------------------------------------------------------------------------
// PollAdapter
// ---------------------------------------------------------------------------

export interface DaemonPollAdapterDeps {
  readonly sessions: Pick<SessionStore, "getById">;
  readonly completionMap: CompletionMap;
}

export function createDaemonPollAdapter(deps: DaemonPollAdapterDeps): PollAdapter {
  return {
    async poll(sessionKey: string): Promise<PollResult> {
      const row = deps.sessions.getById(sessionKey);
      if (!row) {
        return { status: "failed", error: `session not found: ${sessionKey}` };
      }

      // Check completion map first — it has richer info than session status alone.
      const completion = deps.completionMap.get(sessionKey);
      if (completion) {
        if (completion.ok) {
          return { status: "done", output: completion.output, completedAt: completion.completedAt };
        }
        return { status: "failed", error: completion.error, completedAt: completion.completedAt };
      }

      // Fall back to session status.
      if (row.status === "terminated") {
        return { status: "done" };
      }

      return { status: "running" };
    },
  };
}

// ---------------------------------------------------------------------------
// KillAdapter
// ---------------------------------------------------------------------------

export interface DaemonKillAdapterDeps {
  readonly sessionManager: Pick<SessionManager, "kill">;
  /** Optional: abort in-flight model turn before killing the session. */
  readonly requestTurnAbort?: (sessionId: string) => boolean;
}

export function createDaemonKillAdapter(deps: DaemonKillAdapterDeps): KillAdapter {
  return {
    async kill(sessionKey: string): Promise<void> {
      deps.requestTurnAbort?.(sessionKey);
      deps.sessionManager.kill(sessionKey);
    },
  };
}

// ---------------------------------------------------------------------------
// MessageAdapter
// ---------------------------------------------------------------------------

export interface DaemonMessageAdapterDeps {
  /** Lazy getter — messaging context may not be available at construction time. */
  readonly getMessageContext: () =>
    | { execute: (sessionId: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> }
    | undefined;
  readonly resolveChannelId: () => string | undefined;
  /** The session ID this adapter is bound to (set at creation time, per-workflow). */
  readonly sessionId: string;
}

export function createDaemonMessageAdapter(deps: DaemonMessageAdapterDeps): MessageAdapter {
  log.debug("adapter created", { sessionId: deps.sessionId });
  return {
    async postMessage(content: string): Promise<{ messageId: string }> {
      const ctx = deps.getMessageContext();
      const channelId = deps.resolveChannelId();
      log.debug("postMessage", { hasCtx: !!ctx, sessionId: deps.sessionId, channelId: channelId ?? null });
      if (!ctx) { log.error("postMessage: no message context available"); return { messageId: "" }; }

      try {
        const result = await ctx.execute(deps.sessionId, {
          action: "post",
          content: content,
          ...(channelId ? { target: channelId } : {}),
        });

        const res = result as { ok?: boolean; error?: string; message_id?: string };
        if (res.ok === false) {
          log.error("postMessage failed", { error: res.error, sessionId: deps.sessionId, channelId: channelId ?? null });
          return { messageId: "" };
        }

        const id = res.message_id ?? "";
        log.debug("postMessage sent", { messageId: id });
        return { messageId: id };
      } catch (e) {
        log.error("postMessage threw", { err: String(e), sessionId: deps.sessionId });
        return { messageId: "" };
      }
    },

    async editMessage(messageId: string, content: string): Promise<boolean> {
      const ctx = deps.getMessageContext();
      const channelId = deps.resolveChannelId();
      log.debug("editMessage", { hasCtx: !!ctx, messageId, channelId: channelId ?? null });
      if (!ctx) { log.error("editMessage: no message context available"); return false; }

      try {
        const result = await ctx.execute(deps.sessionId, {
          action: "edit",
          content: content,
          message_id: messageId,
          ...(channelId ? { target: channelId } : {}),
        });

        const res = result as { ok?: boolean; error?: string };
        if (res.ok === false) {
          log.error("editMessage failed", { error: res.error, messageId, sessionId: deps.sessionId });
          return false;
        }

        log.debug("editMessage sent", { messageId });
        return true;
      } catch (e) {
        log.error("editMessage threw", { err: String(e), messageId });
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// MessagePoster (for workflow message tasks)
// ---------------------------------------------------------------------------

export interface DaemonMessagePosterDeps {
  /** Lazy getter — messaging context may not be available at construction time. */
  readonly getMessageContext: () =>
    | { execute: (sessionId: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> }
    | undefined;
  readonly logger: ReturnType<typeof getLogger>;
}

export function createDaemonMessagePoster(deps: DaemonMessagePosterDeps): MessagePoster {
  const logger = adaptLogger(deps.logger);
  return {
    async post(target: string, message: string): Promise<void> {
      const ctx = deps.getMessageContext();
      logger.debug("message task posting", { target, messageLen: message.length });
      if (!ctx) {
        logger.warn("message task: no message context available");
        return;
      }

      try {
        const result = await ctx.execute(target, {
          action: "post",
          content: message,
          target,
        });

        const res = result as { ok?: boolean; error?: string };
        if (res.ok === false) {
          logger.warn("message task post failed", { target, error: res.error });
          return;
        }

        logger.debug("message task posted", { target });
      } catch (e) {
        logger.warn("message task post threw", { target, err: String(e) });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// WorkflowToolExecutorAdapter (converts daemon tool context to workflow ToolExecutor)
// ---------------------------------------------------------------------------

export interface WorkflowToolExecutorAdapterDeps {
  readonly sessionId: string;
  readonly getToolContext: () => Promise<import("./sessions/session-mcp-tool-context").SessionMcpToolContext | undefined>;
  readonly logger: ReturnType<typeof getLogger>;
}

/**
 * Adapter that converts the daemon's tool context interface to the workflow ToolExecutor interface.
 * Workflow tasks call execute(tool, args) and expect { ok, output, error }.
 * The daemon's tool context expects { name, argsJson, toolCallId } and returns { resultJson }.
 */
export function createWorkflowToolExecutorAdapter(deps: WorkflowToolExecutorAdapterDeps): ToolExecutor {
  const logger = adaptLogger(deps.logger);

  return {
    async execute(tool: string, args: Record<string, unknown>) {
      const argsJson = JSON.stringify(args);
      const toolCallId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      logger.debug("workflow tool task executing", { tool, sessionId: deps.sessionId, argsLen: argsJson.length });

      try {
        const context = await deps.getToolContext();
        if (!context) {
          logger.warn("workflow tool task: no context available", { tool, sessionId: deps.sessionId });
          return { ok: false, output: "", error: "Tool context not available" };
        }

        const result = await context.execute({ name: tool, argsJson, toolCallId });
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(result.resultJson);
        } catch (e) {
          logger.warn("workflow tool task: failed to parse result", { tool, sessionId: deps.sessionId, error: String(e) });
          return { ok: false, output: "", error: "Tool returned invalid JSON" };
        }

        // Check if the result indicates an error
        if (parsed.error) {
          const errorMsg = (parsed.message as string | undefined) || (parsed.error as string);
          logger.debug("workflow tool task: tool returned error", { tool, sessionId: deps.sessionId, error: errorMsg });
          return { ok: false, output: "", error: errorMsg };
        }

        logger.debug("workflow tool task completed", { tool, sessionId: deps.sessionId });
        return { ok: true, output: result.resultJson };
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logger.warn("workflow tool task failed", { tool, sessionId: deps.sessionId, error: errMsg });
        return { ok: false, output: "", error: errMsg };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// ToolExecutor (for workflow tool tasks)
// ---------------------------------------------------------------------------

export interface DaemonToolExecutorFactoryDeps {
  readonly builtinRegistry: BuiltinToolRegistry;
  readonly sessionMcpRuntime: SessionMcpRuntime;
  readonly logger: ReturnType<typeof getLogger>;
  readonly db: import("better-sqlite3").Database;
  readonly config: import("@shoggoth/shared").ShoggothConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly workspacePath: string;
  readonly creds: import("@shoggoth/os-exec").AgentCredentials;
  readonly orchestratorEnv: NodeJS.ProcessEnv;
  readonly getAgentIntegrationInvoker: () => import("./control/integration-invoke").AgentIntegrationInvoker | undefined;
  readonly getProcessManager: () => import("@shoggoth/procman").ProcessManager | undefined;
  readonly messageToolCtx: import("./sessions/builtin-tool-registry").MessageToolCtx | undefined;
  readonly memoryConfig: import("@shoggoth/shared").ShoggothMemoryConfig;
  readonly runtimeOpenaiBaseUrl: string | undefined;
  readonly imageBlockCodec?: import("@shoggoth/models").ImageBlockCodec;
}

/**
 * Creates a factory function that produces a ToolExecutor for a given session.
 * The executor properly routes tool calls through builtin and external MCP tools.
 */
export function createDaemonToolExecutorFactory(
  deps: DaemonToolExecutorFactoryDeps,
): (sessionId: string) => ToolExecutor {
  const logger = adaptLogger(deps.logger);

  return (sessionId: string): ToolExecutor => {
    let resolvedContext: import("./sessions/session-mcp-tool-context").SessionMcpToolContext | undefined;
    let contextPromise: Promise<import("./sessions/session-mcp-tool-context").SessionMcpToolContext> | undefined;

    const getContext = async () => {
      if (resolvedContext) return resolvedContext;
      if (!contextPromise) {
        contextPromise = deps.sessionMcpRuntime.resolveContext(sessionId);
      }
      resolvedContext = await contextPromise;
      return resolvedContext;
    };

    return {
      async execute({ name, argsJson, toolCallId }) {
        logger.debug("workflow tool task executing", { tool: name, toolCallId, sessionId, argsKeys: Object.keys(JSON.parse(argsJson)) });

        try {
          const mcp = await getContext();
          const { createWorkflowToolExecutor } = await import("./sessions/builtin-handlers/workflow-tool-executor.js");

          const executor = createWorkflowToolExecutor(sessionId, {
            db: deps.db,
            config: deps.config,
            env: deps.env,
            workspacePath: deps.workspacePath,
            creds: deps.creds,
            orchestratorEnv: deps.orchestratorEnv,
            getAgentIntegrationInvoker: deps.getAgentIntegrationInvoker,
            getProcessManager: deps.getProcessManager,
            messageToolCtx: deps.messageToolCtx,
            memoryConfig: deps.memoryConfig,
            runtimeOpenaiBaseUrl: deps.runtimeOpenaiBaseUrl,
            isSubagentSession: true,
            imageBlockCodec: deps.imageBlockCodec,
            builtinRegistry: deps.builtinRegistry,
            sessionMcpContext: mcp,
          });

          const result = await executor.execute({ name, argsJson, toolCallId });
          logger.debug("workflow tool task completed", { tool: name, toolCallId, sessionId });
          return result;
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          logger.warn("workflow tool task execution failed", { tool: name, toolCallId, sessionId, error: errMsg });
          return {
            resultJson: JSON.stringify({
              error: "tool_execution_failed",
              tool: name,
              message: errMsg,
            }),
          };
        }
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Simplified ToolExecutor for workflow tasks (lazy-loaded context)
// ---------------------------------------------------------------------------

export interface DaemonToolExecutorDeps {
  readonly getToolContext: () => Promise<import("./sessions/session-mcp-tool-context").SessionMcpToolContext | undefined>;
  readonly logger: ReturnType<typeof getLogger>;
}

/**
 * Creates a ToolExecutor with lazy-loaded context.
 * Used for workflow tool tasks where context may not be available at construction time.
 */
export function createDaemonToolExecutor(deps: DaemonToolExecutorDeps): ToolExecutor {
  const logger = adaptLogger(deps.logger);

  return {
    async execute({ name, argsJson, toolCallId }) {
      logger.debug("tool executor: executing", { tool: name, toolCallId });

      try {
        const context = await deps.getToolContext();
        if (!context) {
          logger.warn("tool executor: no context available", { tool: name, toolCallId });
          return {
            resultJson: JSON.stringify({
              error: "no_context",
              tool: name,
              message: "Tool context not available",
            }),
          };
        }

        logger.debug("tool executor: context resolved", { tool: name, toolCallId });
        // Execute tool through context
        const result = await context.execute({ name, argsJson, toolCallId });
        logger.debug("tool executor: execution completed", { tool: name, toolCallId });
        return result;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logger.warn("tool executor: execution failed", { tool: name, toolCallId, error: errMsg });
        return {
          resultJson: JSON.stringify({
            error: "execution_failed",
            tool: name,
            message: errMsg,
          }),
        };
      }
    },
  };
}
