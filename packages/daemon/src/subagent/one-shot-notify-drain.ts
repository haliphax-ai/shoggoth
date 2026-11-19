// ---------------------------------------------------------------------------
// one-shot notify drain — keep a finished one-shot alive for pending notifies
// ---------------------------------------------------------------------------
//
// A one-shot subagent's turn ends the moment the model stops, but the task may
// have backgrounded `builtin-exec` calls with `notify: true` that have not
// finished yet. Terminating the session at turn finish cancels every pending
// handle (SessionManager.kill → ExecNotifyScheduler.cancelBySession), so the
// completion notifications never arrive and the subagent cannot react to its
// own background jobs.
//
// Instead, when a one-shot finishes its turn with live notify handles, the
// session is HELD: it stays `active` and the pending completion notifications
// keep their delivery path (in-turn steer or the OOB turn). The last handle
// to resolve releases the hold — but only after that notification is
// delivered and its wake-up turn settles, so a release can never destroy the
// notification it was held for (issue #620). An operator kill drains the hold
// immediately; the persisted wall-clock TTL safety timer caps the hold.
//
// The teardown decision also honors in-flight deliveries and steers the
// settling turn left unanswered: the direct terminate path defers while a
// delivery (exec-notify or any OOB turn) is still running, and steering
// messages consumed by a turn that aborted or failed — the model never
// responded to them — are re-delivered as an out-of-band turn on the
// still-active session before the teardown fires. The same wall-clock TTL
// safety timer caps the whole wait.

import type Database from "better-sqlite3";
import type { HitlAutoApproveGate } from "../hitl/hitl-auto-approve";
import type { Logger } from "../logging";
import { getLogger } from "../logging";
import { getExecNotifyScheduler } from "../exec/exec-notify-scheduler";
import { subagentRuntimeExtensionRef } from "./subagent-extension-ref";
import type { SessionManager } from "../sessions/session-manager";
import type { SessionStore } from "../sessions/session-store";
import { tryGetTurnQueue } from "../sessions/session-turn-queue-singleton";
import { steerDepth, takeUnansweredSteers } from "../sessions/steer-channel";
import { terminatePersistentSubagentSession } from "./subagent-kill";
import {
  beginOneShotDelivery as beginOneShotDeliveryWindow,
  clearAllOneShotDeliveryWindows,
  isOneShotDeliveryInFlight,
  settleOneShotDelivery as settleOneShotDeliveryWindow,
} from "./one-shot-wake-window";
import { deliverOneShotFollowupResult } from "./one-shot-result-delivery";
import { extractLatestTranscriptAssistantText } from "../sessions/transcript-to-chat";

/** Fallback cap for the hold when the session row carries no valid expiry. */
const DEFAULT_ONE_SHOT_NOTIFY_DRAIN_TIMEOUT_MS = 60 * 60_000;

/** Terminate callbacks for held one-shot sessions, keyed by session id. */
export const pendingDrains = new Map<string, () => void>();

/**
 * Deferred releases keyed by session; the value is the terminate callback
 * captured at drain time so a re-armed hold can supersede it by identity.
 */
const pendingReleases = new Map<string, () => void>();

/** Unsubscribe handles for armed turn-end listeners, keyed by session id. */
const armedWakeUpListeners = new Map<string, () => void>();

/** Sessions with a steer re-delivery turn currently running. */
const redeliveryInFlight = new Set<string>();

/**
 * Sessions whose steer re-delivery turn failed or was aborted: the next
 * release decision tears down instead of re-delivering again (one attempt;
 * the TTL safety timer remains the absolute backstop).
 */
const redeliveryFailed = new Set<string>();

/**
 * Session store bound by the most recent settle call, used to re-check the
 * target row before re-delivering steers (never enqueue a turn onto a
 * terminated session).
 */
let storeRef: SessionStore | undefined;

/**
 * Bind the shared session store (daemon startup) so the teardown's steer
 * re-delivery and the OOB-delivery guards can resolve session rows without
 * threading a new parameter through every caller.
 */
export function bindOneShotSessionStore(sessions: SessionStore): void {
  storeRef = sessions;
}

function turnQueueBusy(sid: string): boolean {
  const queue = tryGetTurnQueue();
  if (!queue) return false;
  if (queue.isRunning(sid)) return true;
  const depth = queue.getDepth(sid);
  return depth.system + depth.user > 0;
}

function disarmWakeUpListener(sid: string): void {
  const unsubscribe = armedWakeUpListeners.get(sid);
  if (!unsubscribe) return;
  armedWakeUpListeners.delete(sid);
  unsubscribe();
}

/**
 * Land a drained release once the wake-up chain has settled. A re-armed hold
 * supersedes the captured callback; a busy queue defers to the next turn end.
 * The live handle count is re-read here: the count that drained the hold went
 * stale the moment a wake-up turn could have registered new handles. Steering
 * messages the settling turns left unanswered are re-delivered before the
 * termination fires.
 */
function tryReleaseOneShot(sid: string, terminate: () => void): void {
  if (pendingDrains.get(sid) !== terminate) {
    // A newer hold replaced this one; it owns the teardown.
    pendingReleases.delete(sid);
    disarmWakeUpListener(sid);
    return;
  }
  if (redeliveryInFlight.has(sid) || isOneShotDeliveryInFlight(sid) || turnQueueBusy(sid)) {
    armWakeUpListener(sid, terminate);
    return;
  }
  const liveHandles = getExecNotifyScheduler()?.liveHandleCount(sid) ?? 0;
  if (liveHandles > 0) {
    // The wake-up turn registered new handles; wait for those to drain.
    return;
  }
  if (redeliveryFailed.has(sid)) {
    // The re-delivery attempt already ran and failed again; tearing down is
    // better than retrying forever (the safety timer also bounds this).
    redeliveryFailed.delete(sid);
  } else if (steerDepth(sid) > 0) {
    startSteerRedelivery(sid, terminate, getLogger("one-shot-notify-drain"));
    return;
  }
  pendingReleases.delete(sid);
  pendingDrains.delete(sid);
  disarmWakeUpListener(sid);
  terminate();
}

/** Arm the turn-end listener that lands the deferred release. */
function armWakeUpListener(sid: string, terminate: () => void): void {
  pendingReleases.set(sid, terminate);
  if (armedWakeUpListeners.has(sid)) return;
  const queue = tryGetTurnQueue();
  if (!queue) return; // no queue (tests): the safety timer caps the hold
  const onTurnEnd = (endedSid: string): void => {
    if (endedSid !== sid) return;
    // Turn-end fires with the running slot still held: check on a microtask.
    void Promise.resolve().then(() => {
      const captured = pendingReleases.get(sid);
      if (!captured) {
        disarmWakeUpListener(sid);
        return;
      }
      tryReleaseOneShot(sid, captured);
    });
  };
  const { unsubscribe } = queue.addTurnEndListener(onTurnEnd);
  armedWakeUpListeners.set(sid, unsubscribe);
}

/**
 * Re-deliver steering messages their receiving turn left unanswered (the turn
 * aborted or failed before the model responded). Runs one structured OOB turn
 * on the still-active session; a normal settle then resumes the teardown. The
 * target row is re-checked first — a terminated session never receives the
 * re-delivery turn.
 */
function startSteerRedelivery(sid: string, terminate: () => void, log: Logger): void {
  redeliveryInFlight.add(sid);
  void (async () => {
    try {
      const ext = subagentRuntimeExtensionRef.current;
      if (!ext) {
        log.warn("steer re-delivery skipped: subagent runtime not available", { sessionId: sid });
        redeliveryFailed.add(sid);
        return;
      }
      const row = storeRef?.getById(sid);
      if (row?.status === "terminated") {
        log.warn("steer re-delivery skipped: target session terminated", { sessionId: sid });
        redeliveryFailed.add(sid);
        return;
      }
      const outstanding = takeUnansweredSteers(sid);
      if (outstanding.length === 0) {
        // Nothing actually outstanding (e.g. only queued-but-never-injected
        // entries remained): mark the attempt consumed so the release check
        // cannot re-trigger the redelivery indefinitely.
        redeliveryFailed.add(sid);
        return;
      }
      log.info("re-delivering steers unanswered by an aborted or failed turn", {
        sessionId: sid,
        count: outstanding.length,
      });
      const turn = await ext.runSessionModelTurn({
        sessionId: sid,
        userContent: outstanding.join("\n\n"),
        userMetadata: { steer_redelivery: true },
        delivery: { kind: "internal" },
        systemContext: {
          kind: "session.steer",
          summary:
            "This turn re-delivers steering directive(s) that an earlier turn received but never answered (that turn aborted or failed). Respond to them now.",
        },
      });
      if (
        turn?.outcome === "aborted" ||
        turn?.outcome === "failed" ||
        turn?.outcome === "canceled"
      ) {
        redeliveryFailed.add(sid);
      }
    } catch (e) {
      log.warn("steer re-delivery turn failed", { sessionId: sid, err: String(e) });
      redeliveryFailed.add(sid);
    } finally {
      redeliveryInFlight.delete(sid);
      // The captured terminate is identity-checked inside tryReleaseOneShot:
      // a superseded hold is cleaned up instead of fired.
      tryReleaseOneShot(sid, terminate);
    }
  })();
}

/**
 * Release the hold when the session has no live handles left. A positive
 * `liveCount` (e.g. the delivery turn backgrounded new execs) keeps the hold.
 * The release defers — never skips — while a wake-up is in flight or busy;
 * the hold entry stays armed so its safety timer still bounds the wait.
 */
export function releaseOneShotIfDrained(sessionId: string, liveCount: number): void {
  const sid = sessionId.trim();
  const terminate = pendingDrains.get(sid);
  if (!terminate) return;
  if (liveCount > 0) return;
  const pending = pendingReleases.get(sid);
  if (pending) {
    tryReleaseOneShot(sid, pending);
    return;
  }
  if (isOneShotDeliveryInFlight(sid) || turnQueueBusy(sid)) {
    getLogger("one-shot-notify-drain").debug(
      "one-shot release deferred: delivery wake-up in flight",
      { sessionId: sid },
    );
    armWakeUpListener(sid, terminate);
    return;
  }
  tryReleaseOneShot(sid, terminate);
}

/**
 * Land a drained release after a wake-up window settles: the window marker is
 * cleared, and any release a concurrent settle deferred lands here.
 */
function settleOneShotDeliveryAndRelease(sessionId: string): void {
  const sid = sessionId.trim();
  settleOneShotDeliveryWindow(sid);
  const pending = pendingReleases.get(sid);
  if (pending) tryReleaseOneShot(sid, pending);
}

/**
 * Hold a one-shot session until its pending exec-notify handles drain.
 * Idempotent per session: the first hold wins and keeps its safety timer.
 * Returns the callback stored in the hold map so callers can land releases
 * through the same identity `tryReleaseOneShot` checks.
 */
function holdOneShotForNotifyDrain(input: {
  readonly sessionId: string;
  readonly terminate: () => void;
  readonly timeoutMs: number;
}): () => void {
  const sid = input.sessionId.trim();
  if (pendingDrains.has(sid)) {
    // First hold wins — the returned callback is the existing one so an
    // identity-checked release still matches.
    return pendingDrains.get(sid)!;
  }
  const safety = setTimeout(
    () => {
      // TTL elapsed without the handles draining — terminate as a normal end.
      pendingReleases.delete(sid);
      disarmWakeUpListener(sid);
      redeliveryInFlight.delete(sid);
      pendingDrains.delete(sid);
      input.terminate();
    },
    Math.max(0, input.timeoutMs),
  );
  const drain = (): void => {
    clearTimeout(safety);
    input.terminate();
  };
  pendingDrains.set(sid, drain);
  return drain;
}

/**
 * End-of-turn teardown for a one-shot child session: terminate immediately
 * when nothing is pending (the historical behavior), otherwise hold the
 * session until its pending exec-notify handles drain (capped by the
 * persisted wall-clock expiry).
 *
 * `turnOutcome` is the settling turn's own result. A turn that ended
 * non-normally (`aborted` / `failed` / `canceled`) never answers the steers
 * it received; when the session has no other pending work, the outstanding
 * messages are re-delivered as an OOB turn before the teardown fires. A
 * failed turn with no unanswered steers tears down normally.
 */
export function settleOneShotAfterTurn(input: {
  readonly sessionManager: SessionManager;
  readonly sessions: SessionStore;
  readonly stateDb?: Database.Database;
  readonly sessionId: string;
  readonly autoApproveGate?: HitlAutoApproveGate;
  readonly subLog: Logger;
  /** Outcome of the turn that is settling (undefined = unknown/legacy caller). */
  readonly turnOutcome?: "completed" | "aborted" | "failed" | "canceled";
}): void {
  const sid = input.sessionId.trim();
  storeRef = input.sessions;
  const terminate = (): void => terminateOneShotWithFinalResult(input, sid);
  const scheduler = getExecNotifyScheduler();
  const liveNotifies =
    scheduler && input.stateDb ? scheduler.countForSession(input.stateDb, sid) : 0;
  const turnEndedNonNormally = input.turnOutcome !== undefined && input.turnOutcome !== "completed";
  if (liveNotifies <= 0) {
    if (turnEndedNonNormally && steerDepth(sid) > 0) {
      // The turn consumed the steering messages but died before answering
      // them. Hold the session (TTL-capped) just long enough to re-deliver
      // them, then run the normal teardown.
      const row = input.sessions.getById(sid);
      const expiry = row?.subagentExpiresAtMs;
      const timeoutMs =
        typeof expiry === "number" && Number.isFinite(expiry) && expiry > 0
          ? Math.max(0, expiry - Date.now())
          : DEFAULT_ONE_SHOT_NOTIFY_DRAIN_TIMEOUT_MS;
      const drain = holdOneShotForNotifyDrain({ sessionId: sid, terminate, timeoutMs });
      input.subLog.info("one-shot held: re-delivering steers its failed turn left unanswered", {
        sessionId: sid,
        timeoutMs,
      });
      startSteerRedelivery(sid, drain, input.subLog);
      return;
    }
    if (turnEndedNonNormally) {
      input.subLog.warn("one-shot turn ended without answering its steers", {
        sessionId: sid,
        turnOutcome: input.turnOutcome,
      });
    }
    if (isOneShotDeliveryInFlight(sid) || turnQueueBusy(sid)) {
      // A wake-up delivery (exec-notify or another OOB turn) is still running
      // for this session: the direct terminate would abort it mid-flight.
      // Defer the teardown to the turn end; the TTL safety timer caps it.
      const row = input.sessions.getById(sid);
      const expiry = row?.subagentExpiresAtMs;
      const timeoutMs =
        typeof expiry === "number" && Number.isFinite(expiry) && expiry > 0
          ? Math.max(0, expiry - Date.now())
          : DEFAULT_ONE_SHOT_NOTIFY_DRAIN_TIMEOUT_MS;
      const drain = holdOneShotForNotifyDrain({ sessionId: sid, terminate, timeoutMs });
      input.subLog.info("one-shot teardown deferred: a wake-up delivery is still in flight", {
        sessionId: sid,
        timeoutMs,
      });
      tryReleaseOneShot(sid, drain);
      return;
    }
    terminate();
    return;
  }
  const row = input.sessions.getById(sid);
  const expiry = row?.subagentExpiresAtMs;
  const timeoutMs =
    typeof expiry === "number" && Number.isFinite(expiry) && expiry > 0
      ? Math.max(0, expiry - Date.now())
      : DEFAULT_ONE_SHOT_NOTIFY_DRAIN_TIMEOUT_MS;
  holdOneShotForNotifyDrain({ sessionId: sid, terminate, timeoutMs });
  if (turnEndedNonNormally && steerDepth(sid) > 0) {
    input.subLog.info("one-shot held: its failed turn leaves steers to re-deliver at drain", {
      sessionId: sid,
      liveNotifies,
      timeoutMs,
    });
  } else {
    input.subLog.info("one-shot held for pending exec-notify handles", {
      sessionId: sid,
      liveNotifies,
      timeoutMs,
    });
  }
}

/**
 * Record the latest transcript text the spawn path already delivered to the
 * parent (the first settled turn's result). A later teardown delivers the
 * subagent's transcript only when its latest text differs — steering a
 * one-shot produces a newer reply, and that is the delta the parent must see
 * instead of silence. Cleared with the other module state in
 * {@link clearAllOneShotNotifyDrains}.
 */
const lastDeliveredResultText = new Map<string, string>();

/**
 * Mark the delivered result for a one-shot session (spawn path, after
 * `deliverSubagentResult` resolved for the first settled turn). The teardown
 * compares against this when deciding whether the parent has already seen the
 * transcript's final text.
 */
export function markOneShotResultDelivered(sessionId: string, assistantText: string): void {
  lastDeliveredResultText.set(sessionId.trim(), assistantText);
}

/**
 * The teardown that fires at the end of the LAST settle: deliver the one-shot's
 * final transcript text as a structured OOB follow-up turn to its parent when
 * that text was not already delivered (the normal case for a steered follow-up
 * turn), then terminate the session.
 *
 * Every teardown path — the direct one here, the deferred release in
 * {@link tryReleaseOneShot}, and the safety timer inside
 * `holdOneShotForNotifyDrain` — routes through this closure, so the parent
 * always hears one of "result" or (via the terminate notice) "ended" for the
 * post-steer lifetime of the child.
 */
function terminateOneShotWithFinalResult(
  input: {
    readonly sessionManager: SessionManager;
    readonly sessions: SessionStore;
    readonly stateDb?: Database.Database;
    readonly sessionId: string;
    readonly autoApproveGate?: HitlAutoApproveGate;
    readonly subLog: Logger;
  },
  sid: string,
): void {
  // The plain teardown every no-follow-up path shares.
  const teardown = (): void =>
    terminatePersistentSubagentSession(
      input.sessionManager,
      sid,
      undefined,
      input.autoApproveGate,
      "one_shot_teardown",
    );
  const row = storeRef?.getById(sid);
  const followup = pendingFollowupFor(input.stateDb, sid, row);
  // Missing row (legacy callers/tests) or already dead (TTL expiry / operator
  // kill owns the parent notification): tear down exactly as before.
  if (!followup) {
    lastDeliveredResultText.delete(sid);
    teardown();
    return;
  }
  void deliverFollowupThenTerminate(input, sid, followup, teardown);
}

/** A follow-up worth delivering: the undelivered final text and its target. */
interface OneShotFollowup {
  readonly text: string;
  readonly respondTo: string;
}

/**
 * Resolve the follow-up delivery a terminating one-shot owes its parent, if
 * any: the row must be live, have an unread transcript, and that text must
 * differ from what the spawn path already delivered (exact-equality dedupe —
 * both sides read the transcript, so only a turn that settled after the first
 * delivery can differ).
 */
function pendingFollowupFor(
  stateDb: Database.Database | undefined,
  sid: string,
  row:
    | {
        readonly status: string;
        readonly contextSegmentId: string;
        readonly subagentRespondTo: string | undefined;
        readonly parentSessionId: string | undefined;
      }
    | undefined,
): OneShotFollowup | undefined {
  if (!row || row.status === "terminated" || !stateDb) return undefined;
  const text = extractLatestTranscriptAssistantText(stateDb, sid, row.contextSegmentId);
  if (!text || text === lastDeliveredResultText.get(sid)) return undefined;
  return {
    text,
    respondTo: row.subagentRespondTo ?? row.parentSessionId ?? "",
  };
}

/** Deliver the follow-up (never throws), then run the teardown. */
async function deliverFollowupThenTerminate(
  input: {
    readonly subLog: Logger;
  },
  sid: string,
  followup: OneShotFollowup,
  teardown: () => void,
): Promise<void> {
  beginOneShotDeliveryWindow(sid);
  try {
    const deliveredText = await deliverOneShotFollowupResult({
      sessionId: sid,
      parentSessionId: followup.respondTo,
      text: followup.text,
    });
    // Record what this follow-up delivered so a concurrent settle that lands
    // mid-delivery cannot re-deliver the same text.
    lastDeliveredResultText.set(sid, deliveredText);
  } catch (e) {
    input.subLog.warn("one-shot final result delivery failed", {
      sessionId: sid,
      err: String(e),
    });
  } finally {
    // Land any release a concurrent settle deferred behind this delivery,
    // then terminate. A racing settle's own terminate is idempotent.
    settleOneShotDeliveryAndRelease(sid);
    teardown();
  }
}

/** Clear every hold, pending release, and delivery marker (shutdown/tests). */
export function clearAllOneShotNotifyDrains(): void {
  for (const unsubscribe of armedWakeUpListeners.values()) unsubscribe();
  armedWakeUpListeners.clear();
  pendingReleases.clear();
  redeliveryInFlight.clear();
  redeliveryFailed.clear();
  pendingDrains.clear();
  lastDeliveredResultText.clear();
  clearAllOneShotDeliveryWindows();
  storeRef = undefined;
}
