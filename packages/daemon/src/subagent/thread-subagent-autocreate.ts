import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import type { Logger } from "../logging";
import { getLogger } from "../logging";
import { createSessionStore, type SessionStore } from "../sessions/session-store";
import { createTranscriptStore } from "../sessions/transcript-store";
import type { SessionManager } from "../sessions/session-manager";
import { resolveModel } from "../sessions/model-resolution";
import { rememberSubagentHandles } from "./subagent-disposables";
import { armPersistentSubagentInactivityTimer } from "./persistent-subagent-timers";
import { terminatePersistentSubagentSession } from "./subagent-kill";

const log = getLogger("thread-subagent-autocreate");

/** Platform-supplied capabilities used when auto-creating a thread subagent session. */
export interface ThreadSubagentPlatformDeps {
  /** Resolve the session currently bound to a channel (static routes + dynamic thread bindings). */
  readonly resolveSessionForChannel: (channelId: string, guildId?: string) => string | undefined;
  /** Register the thread ↔ session binding for inbound routing + outbound delivery. */
  readonly registerPlatformThreadBinding: (threadId: string, sessionId: string) => () => void;
  /** Subscribe the platform's inbound dispatch to the new session. */
  readonly subscribeSubagentSession: (sessionId: string) => () => void;
  /** Post the status message to the platform thread (URN + current model). */
  readonly sendStatusMessage: (sessionId: string, body: string) => Promise<void>;
}

export interface PlatformThreadCreateInput {
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
  readonly sessionManager: SessionManager;
  readonly sessions?: SessionStore;
  /** Platform thread id (e.g. Discord thread snowflake). */
  readonly threadId: string;
  /** Channel the thread was created in. */
  readonly parentChannelId: string;
  readonly guildId?: string;
  readonly platform: ThreadSubagentPlatformDeps;
  readonly logger?: Logger;
}

export interface ThreadCreateHandlingResult {
  readonly created: boolean;
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  /** Why creation was skipped (when `created` is false). */
  readonly reason?: string;
}

/**
 * Core entry point for platform thread-create events: decides whether an automatic
 * thread-based subagent session should be created and performs the creation when it
 * should. Platforms stay thin — they parse the gateway event, resolve channel→session,
 * and deliver the status message; every decision lives here.
 *
 * Guarantees:
 * - No-op when `agents.threadSubagents` is false.
 * - No-op when the parent channel is unbound or its session is not top-level.
 * - Idempotent: a thread that already has a session binding (durable store or runtime
 *   map) never gets a second session, including re-fired gateway events and threads
 *   restored by the startup reconcile.
 */
export async function handlePlatformThreadCreate(
  input: PlatformThreadCreateInput,
): Promise<ThreadCreateHandlingResult> {
  const sessions = input.sessions ?? createSessionStore(input.db);
  const l = input.logger ?? log;
  const threadId = input.threadId.trim();
  const parentChannelId = input.parentChannelId.trim();
  if (!threadId || !parentChannelId) {
    return { created: false, reason: "invalid_ids" };
  }

  // Enabled by default: only an explicit `agents.threadSubagents: false` disables
  // (same `!== false` read-site semantics as `spawnSubagents` — see
  // effectiveThreadSubagentsEnabled in @shoggoth/shared for the documented helper).
  const agentsCfg = (input.config as { agents?: { threadSubagents?: boolean } } | undefined)
    ?.agents;
  if (agentsCfg?.threadSubagents === false) {
    return { created: false, reason: "disabled" };
  }

  // Idempotency (durable): a session already bound to this thread (fresh creation or a
  // binding restored by reconcile-persistent-subagents after a restart).
  const existing = sessions.list().find((s) => s.subagentPlatformThreadId?.trim() === threadId);
  if (existing) {
    return { created: false, reason: "already_bound" };
  }
  // Idempotency (runtime): the platform already has a live binding for this thread.
  if (input.platform.resolveSessionForChannel(threadId)) {
    return { created: false, reason: "binding_exists" };
  }

  // Trigger guard: the parent channel must bind to a top-level agent session.
  const parentSessionId = input.platform.resolveSessionForChannel(parentChannelId, input.guildId);
  if (!parentSessionId) {
    return { created: false, reason: "parent_unbound" };
  }
  const parent = sessions.getById(parentSessionId);
  if (!parent) {
    return { created: false, reason: "parent_missing" };
  }
  if (parent.status === "terminated") {
    return { created: false, reason: "parent_terminated" };
  }
  // Only top-level agent sessions spawn thread subagents; threads under subagent
  // sessions (or unbound channels) are no-ops.
  if (parent.parentSessionId || parent.subagentMode) {
    return { created: false, reason: "parent_not_top_level" };
  }

  // Same session-creation path as the subagent spawn system: URN minted under the
  // parent agent, workspace/agent profile inherited from the parent session.
  const { sessionId: childId } = await input.sessionManager.spawn({
    parentSessionId,
    parentWorkingDirectory: parent.workspacePath,
  });
  sessions.update(childId, {
    parentSessionId,
    subagentMode: "persistent",
    subagentPlatformThreadId: threadId,
  });

  const unregisterThread = input.platform.registerPlatformThreadBinding(threadId, childId);
  const unsubscribeBus = input.platform.subscribeSubagentSession(childId);
  // Arm the shared inactivity clock (default window, reset on each delivered response)
  // instead of a far-future lifetime; the expiry is persisted for restart reconcile.
  const { dispose: clearTtl } = armPersistentSubagentInactivityTimer(
    {
      sessions,
      onTimeout: (sid) =>
        terminatePersistentSubagentSession(input.sessionManager, sid, "ttl_expired"),
    },
    childId,
  );
  rememberSubagentHandles(childId, {
    unregisterThread,
    unsubscribeBus,
    clearTtl,
  });

  // Status message: session URN + current model, posted to the thread immediately
  // regardless of whether any turn has fired.
  let resolvedModel: ReturnType<typeof resolveModel> = null;
  try {
    resolvedModel = resolveModel(input.db, input.config, { sessionId: childId });
  } catch (e) {
    l.warn("thread_subagent.model_resolution_failed", {
      sessionId: childId,
      err: String(e),
    });
  }
  const modelLabel = resolvedModel ? resolvedModel.ref : "default (agent default)";
  const statusBody = [
    "Thread subagent session created.",
    `Session: ${childId}`,
    `Model: ${modelLabel}`,
  ].join("\n");
  try {
    await input.platform.sendStatusMessage(childId, statusBody);
  } catch (e) {
    l.warn("thread_subagent.status_send_failed", {
      sessionId: childId,
      threadId,
      err: String(e),
    });
  }

  l.info("thread_subagent.created", {
    sessionId: childId,
    parentSessionId,
    threadId,
  });
  return { created: true, sessionId: childId, parentSessionId };
}

/**
 * Thread sessions ignore a leading inbound message that is only "." (a single dot) while
 * they have no transcript history yet. This sentinel lets the operator set the thread up
 * (e.g. switch the model) before submitting a real prompt; the session stays bound and
 * later messages fire turns normally. Called by platform inbound handlers upstream of
 * turn execution; the decision itself is platform-agnostic.
 */
export function shouldSkipThreadSessionSentinel(input: {
  readonly db: Database.Database;
  readonly sessions: SessionStore;
  readonly sessionId: string;
  readonly body: string;
}): boolean {
  if (!input.db || !input.sessionId || typeof input.body !== "string") return false;
  if (input.body.trim() !== ".") return false;
  const row = input.sessions.getById(input.sessionId);
  if (!row || row.subagentMode !== "persistent" || !row.subagentPlatformThreadId?.trim()) {
    return false;
  }
  const { messages } = createTranscriptStore(input.db).listPage({
    sessionId: input.sessionId,
    contextSegmentId: row.contextSegmentId,
    afterSeq: 0,
    limit: 1,
  });
  return messages.length === 0;
}
