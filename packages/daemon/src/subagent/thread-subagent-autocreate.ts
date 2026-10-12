import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import type { Logger } from "../logging";
import { getLogger } from "../logging";
import { createSessionStore, type SessionRow, type SessionStore } from "../sessions/session-store";
import { createTranscriptStore } from "../sessions/transcript-store";
import type { SessionManager } from "../sessions/session-manager";
import { resolveModel } from "../sessions/model-resolution";
import { rememberSubagentHandles } from "./subagent-disposables";
import { armPersistentSubagentInactivityTimer } from "./persistent-subagent-timers";
import { terminatePersistentSubagentSession } from "./subagent-kill";
import { isThreadClaimedByControlPlaneSpawn } from "./thread-subagent-claims";

const log = getLogger("thread-subagent-autocreate");

/** Platform-supplied capabilities used when auto-creating a thread subagent session. */
export interface ThreadSubagentPlatformDeps {
  /** Resolve the session currently bound to a channel (static routes + dynamic thread bindings). */
  readonly resolveSessionForChannel: (channelId: string, guildId?: string) => string | undefined;
  /**
   * Register the thread ↔ session binding for inbound routing + outbound
   * delivery. Throws when the thread is already bound to a different live
   * session; callers must treat that as a lost race and clean up.
   */
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
 * Compose the thread subagent creation banner (session URN + current model).
 * Shared by the automatic thread-create path and the manual `subagent_spawn`
 * control op so both post the same banner, in the same wording, before the
 * session's first model turn.
 */
export function buildThreadSubagentCreatedBanner(input: {
  readonly db: Database.Database;
  readonly config: ShoggothConfig;
  readonly sessionId: string;
  readonly logger?: Logger;
}): string {
  const l = input.logger ?? log;
  let resolvedModel: ReturnType<typeof resolveModel> = null;
  try {
    resolvedModel = resolveModel(input.db, input.config, { sessionId: input.sessionId });
  } catch (e) {
    l.warn("thread_subagent.model_resolution_failed", {
      sessionId: input.sessionId,
      err: String(e),
    });
  }
  const modelLabel = resolvedModel ? resolvedModel.ref : "default (agent default)";
  return [
    "> 🧵 Thread subagent session created.",
    `> 🎯 **Session:** \`${input.sessionId}\``,
    `> 🥸 **Model:** \`${modelLabel}\``,
  ].join("\n");
}

/**
 * Find the session a control-plane spawn may adopt when its thread binding is refused:
 * the freshly autocreated thread subagent — a live, persistent, thread-bound session that
 * has never fired a turn (banner-only, zero transcript messages). Adoption hands the
 * thread back to the spawn op, which delivers its prompt as the session's first model
 * turn instead of failing the spawn and leaving a banner-only zombie.
 *
 * Returns undefined when no adoptable session exists (an unrelated session holds the
 * thread, or the autocreated one already has history), so callers fail the spawn the
 * usual way.
 */
export function findAdoptableThreadSubagentSession(input: {
  readonly sessions: SessionStore;
  readonly db: Database.Database;
  readonly threadId: string;
  readonly parentSessionId?: string;
  /** The spawn op's own child session — never adoptable (it already claims the thread row). */
  readonly excludeSessionId?: string;
}): SessionRow | undefined {
  const threadId = input.threadId.trim();
  if (!threadId) return undefined;
  const candidate = input.sessions.list().find(
    (s) =>
      s.id !== input.excludeSessionId &&
      s.subagentPlatformThreadId?.trim() === threadId &&
      s.subagentMode === "persistent" &&
      s.status !== "terminated" &&
      // Freshly autocreated under the same parent; an adoption must not grab an
      // unrelated live subagent that happens to share the thread.
      (!input.parentSessionId || s.parentSessionId === input.parentSessionId),
  );
  if (!candidate) return undefined;
  const { messages } = createTranscriptStore(input.db).listPage({
    sessionId: candidate.id,
    contextSegmentId: candidate.contextSegmentId,
    afterSeq: 0,
    limit: 1,
  });
  return messages.length === 0 ? candidate : undefined;
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
 * - No-op with `control_plane_claimed` when the thread (or a pending creation in the
 *   parent channel) is claimed by an in-flight control-plane `subagent_spawn`, which
 *   binds its own session instead.
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

  // Control-plane spawn claim: this thread (or a pending thread creation in this parent
  // channel) belongs to an in-flight `subagent_spawn` op, which will bind its own session
  // and deliver the spawn prompt as the thread's first turn. Autocreating here would race
  // that op and leave a banner-only zombie session behind.
  if (isThreadClaimedByControlPlaneSpawn({ threadId, parentChannelId })) {
    return { created: false, reason: "control_plane_claimed" };
  }

  // Enabled by default: only an explicit `agents.threadSubagents: false` disables
  // (same `!== false` read-site semantics as other boolean flags — see
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

  let unregisterThread: () => void;
  try {
    unregisterThread = input.platform.registerPlatformThreadBinding(threadId, childId);
  } catch (bindErr) {
    // A concurrent flow (e.g. an explicit subagent spawn racing this create
    // event) won the thread: the binding is rejected, not reassigned. Clean up
    // the just-spawned child so no orphan session lingers.
    l.warn("thread_subagent.binding_rejected", {
      sessionId: childId,
      threadId,
      err: String(bindErr),
    });
    try {
      input.sessionManager.kill(childId);
    } catch (killErr) {
      l.warn("thread_subagent.binding_rejected_cleanup_failed", {
        sessionId: childId,
        err: String(killErr),
      });
    }
    return { created: false, reason: "binding_rejected" };
  }
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
  const statusBody = buildThreadSubagentCreatedBanner({
    db: input.db,
    config: input.config,
    sessionId: childId,
    logger: l,
  });
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
