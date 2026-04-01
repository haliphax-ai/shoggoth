/**
 * Real daemon adapters for the fan-out orchestrator.
 *
 * Each adapter wraps daemon internals (session manager, session store, messaging)
 * behind the fan-out package's dependency-injection interfaces.
 */

import type {
  SpawnAdapter,
  SpawnRequest,
  PollAdapter,
  PollResult,
  KillAdapter,
  MessageAdapter,
  NotifyAdapter,
} from "@shoggoth/fan-out";
import type { SessionManager } from "./sessions/session-manager.js";
import type { SessionStore, SessionRow } from "./sessions/session-store.js";

// ---------------------------------------------------------------------------
// Completion tracking for spawned subagent turns
// ---------------------------------------------------------------------------

export type CompletionEntry =
  | { ok: true; output: string }
  | { ok: false; error: string };

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
  /** Optional map to track completion of spawned turns. Created internally if not provided. */
  readonly completionMap?: CompletionMap;
}

export function createDaemonSpawnAdapter(deps: DaemonSpawnAdapterDeps): SpawnAdapter & { completionMap: CompletionMap } {
  const completionMap: CompletionMap = deps.completionMap ?? new Map();

  return {
    completionMap,
    async spawn(req: SpawnRequest): Promise<string> {
      const parentSessionId = deps.parentSessionId ?? req.replyTo;

      const { sessionId: childId } = deps.sessionManager.spawn({
        parentSessionId,
      });

      deps.sessions.update(childId, {
        parentSessionId,
        subagentMode: "one_shot",
      });

      // Fire off the model turn without awaiting — poll adapter tracks completion.
      const turnPromise = deps.runSessionModelTurn({
        sessionId: childId,
        userContent: req.prompt,
        userMetadata: {
          fan_out_task_id: req.taskId,
          subagent_one_shot: true,
          parent_session_id: parentSessionId,
          respond_to: req.replyTo,
          internal: true,
        },
        systemContext: {
          kind: "fan_out.task",
          summary: "You are executing a fan-out task.",
          guidance: "Execute the task described in the message content. Focus only on this task and return your result.",
          data: { workflow_id: req.workflowId ?? null, task_id: req.taskId },
        },
        delivery: { kind: "internal" },
      });

      turnPromise
        .then((result) => {
          completionMap.set(childId, { ok: true, output: result.latestAssistantText });
        })
        .catch((err) => {
          completionMap.set(childId, { ok: false, error: String(err) });
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
          return { status: "done", output: completion.output };
        }
        return { status: "failed", error: completion.error };
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

function log(level: string, msg: string, fields: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, msg, component: "fan-out-msg", ...fields });
  process.stderr.write(entry + "\n");
}

export function createDaemonMessageAdapter(deps: DaemonMessageAdapterDeps): MessageAdapter {
  log("debug", "adapter created", { sessionId: deps.sessionId });
  return {
    async postMessage(content: string): Promise<{ messageId: string }> {
      const ctx = deps.getMessageContext();
      const channelId = deps.resolveChannelId();
      log("debug", "postMessage", { hasCtx: !!ctx, sessionId: deps.sessionId, channelId: channelId ?? null });
      if (!ctx) { log("error", "postMessage: no message context available"); return { messageId: "" }; }

      try {
        const result = await ctx.execute(deps.sessionId, {
          action: "post",
          content: content,
          ...(channelId ? { target: channelId } : {}),
        });

        const res = result as { ok?: boolean; error?: string; message_id?: string };
        if (res.ok === false) {
          log("error", "postMessage failed", { error: res.error, sessionId: deps.sessionId, channelId: channelId ?? null });
          return { messageId: "" };
        }

        const id = res.message_id ?? "";
        log("debug", "postMessage sent", { messageId: id });
        return { messageId: id };
      } catch (e) {
        log("error", "postMessage threw", { err: String(e), sessionId: deps.sessionId });
        return { messageId: "" };
      }
    },

    async editMessage(messageId: string, content: string): Promise<boolean> {
      const ctx = deps.getMessageContext();
      const channelId = deps.resolveChannelId();
      log("debug", "editMessage", { hasCtx: !!ctx, messageId, channelId: channelId ?? null });
      if (!ctx) { log("error", "editMessage: no message context available"); return false; }

      try {
        const result = await ctx.execute(deps.sessionId, {
          action: "edit",
          content: content,
          message_id: messageId,
          ...(channelId ? { target: channelId } : {}),
        });

        const res = result as { ok?: boolean; error?: string };
        if (res.ok === false) {
          log("error", "editMessage failed", { error: res.error, messageId, sessionId: deps.sessionId });
          return false;
        }

        log("debug", "editMessage sent", { messageId });
        return true;
      } catch (e) {
        log("error", "editMessage threw", { err: String(e), messageId });
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// NotifyAdapter (fan-out completion notification)
// ---------------------------------------------------------------------------

export interface FanOutNotifierDeps {
  /** Lazy getter — the runtime extension may not be available at construction time. */
  readonly getRunSessionModelTurn: () =>
    | ((input: {
        readonly sessionId: string;
        readonly userContent: string;
        readonly userMetadata?: Record<string, unknown>;
        readonly systemContext?: { kind: string; summary: string; data?: Record<string, unknown>; guidance?: string };
        readonly delivery: { kind: string; userId?: string };
      }) => Promise<{ latestAssistantText: string; failoverMeta?: unknown }>)
    | undefined;
  /** Resolve the delivery descriptor for a target session. Defaults to internal when not provided. */
  readonly resolveDelivery?: (sessionId: string) => { kind: string; userId?: string };
  readonly logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; debug: (...args: unknown[]) => void };
}

export function createFanOutNotifier(deps: FanOutNotifierDeps): NotifyAdapter {
  return {
    async notify(workflowId: string, success: boolean, context?: { replyTo: string }): Promise<void> {
      deps.logger.info("fan-out workflow completed", { workflowId, success, replyTo: context?.replyTo ?? null });
      try {
        const sessionId = context?.replyTo;
        if (!sessionId) { deps.logger.warn("fan-out notify: no replyTo in context"); return; }

        const runTurn = deps.getRunSessionModelTurn();
        if (!runTurn) { deps.logger.warn("fan-out notify: subagent runtime not available"); return; }

        const status = success ? "✅ completed successfully" : "❌ completed with failures";
        const message = `**Fan-out workflow ${status}:** \`${workflowId}\``;

        deps.logger.debug("fan-out notify: delivering to session", { sessionId });
        const delivery = deps.resolveDelivery?.(sessionId) ?? { kind: "internal" };
        deps.logger.debug("fan-out notify: resolved delivery", { sessionId, deliveryKind: delivery.kind });
        await runTurn({
          sessionId,
          userContent: message,
          userMetadata: { fan_out_notify: true, workflow_id: workflowId, success },
          systemContext: {
            kind: "fan_out.complete",
            summary: `Fan-out workflow completed ${success ? "successfully" : "with failures"}.`,
            guidance: "The user can already see task statuses, durations, total duration, and workflow completion in the automated status post. Surface any meaningful information beyond that, or simply acknowledge completion in your own voice.",
            data: { workflow_id: workflowId, success },
          },
          delivery,
        });
        deps.logger.debug("fan-out notify: delivered");
      } catch (e) {
        deps.logger.warn("fan-out completion notification failed", { workflowId, err: String(e) });
      }
    },
  };
}
