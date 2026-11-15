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
// immediately; the persisted wall-clock TTL safety timer caps the wait.

import type Database from "better-sqlite3";
import type { HitlAutoApproveGate } from "../hitl/hitl-auto-approve";
import type { Logger } from "../logging";
import { getLogger } from "../logging";
import { getExecNotifyScheduler } from "../exec/exec-notify-scheduler";
import type { SessionManager } from "../sessions/session-manager";
import type { SessionStore } from "../sessions/session-store";
import { tryGetTurnQueue } from "../sessions/session-turn-queue-singleton";
import { terminatePersistentSubagentSession } from "./subagent-kill";

/** Fallback cap for the hold when the session row carries no valid expiry. */
const DEFAULT_ONE_SHOT_NOTIFY_DRAIN_TIMEOUT_MS = 60 * 60_000;

/** Terminate callbacks for held one-shot sessions, keyed by session id. */
export const pendingDrains = new Map<string, () => void>();

/** Wake-up chains in flight; a drained release never lands while set. */
const deliveryInFlight = new Set<string>();

/**
 * Deferred releases keyed by session; the value is the terminate callback
 * captured at drain time so a re-armed hold can supersede it by identity.
 */
const pendingReleases = new Map<string, () => void>();

/** Unsubscribe handles for armed turn-end listeners, keyed by session id. */
const armedWakeUpListeners = new Map<string, () => void>();

/** Idle when the queue is absent (tests, minimal embeds). */
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
 * stale the moment a wake-up turn could have registered new handles.
 */
function tryReleaseOneShot(sid: string, terminate: () => void): void {
  if (pendingDrains.get(sid) !== terminate) {
    // A newer hold replaced this one; it owns the teardown.
    pendingReleases.delete(sid);
    disarmWakeUpListener(sid);
    return;
  }
  if (deliveryInFlight.has(sid) || turnQueueBusy(sid)) {
    armWakeUpListener(sid, terminate);
    return;
  }
  const liveHandles = getExecNotifyScheduler()?.liveHandleCount(sid) ?? 0;
  if (liveHandles > 0) {
    // The wake-up turn registered new handles; wait for those to drain.
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
  if (deliveryInFlight.has(sid) || turnQueueBusy(sid)) {
    getLogger("one-shot-notify-drain").debug(
      "one-shot release deferred: delivery wake-up in flight",
      { sessionId: sid },
    );
    armWakeUpListener(sid, terminate);
    return;
  }
  // Delete before terminating so the kill's own cancelBySession → listener
  // round-trip is a no-op.
  pendingDrains.delete(sid);
  terminate();
}

/**
 * Begin a wake-up window: drained releases defer until settleOneShotDelivery.
 * Must precede the delivery's write to the session (steer push or turn
 * enqueue) so a release cannot interleave.
 */
export function beginOneShotDelivery(sessionId: string): void {
  deliveryInFlight.add(sessionId.trim());
}

/** Settle the wake-up window; a deferred release lands when the queue idles. */
export function settleOneShotDelivery(sessionId: string): void {
  const sid = sessionId.trim();
  deliveryInFlight.delete(sid);
  const pending = pendingReleases.get(sid);
  if (pending) tryReleaseOneShot(sid, pending);
}

/**
 * Wrap an OOB fallback delivery: the steer drop callback fires between turns
 * (queue momentarily idle), so the marker must cover the fallback turn too.
 */
export async function oneShotWakeFallback<T>(
  sessionId: string,
  inner: () => Promise<T>,
): Promise<T> {
  const sid = sessionId.trim();
  beginOneShotDelivery(sid);
  try {
    return await inner();
  } finally {
    settleOneShotDelivery(sid);
  }
}

/**
 * Hold a one-shot session until its pending exec-notify handles drain.
 * Idempotent per session: the first hold wins and keeps its safety timer.
 */
function holdOneShotForNotifyDrain(input: {
  readonly sessionId: string;
  readonly terminate: () => void;
  readonly timeoutMs: number;
}): void {
  const sid = input.sessionId.trim();
  if (pendingDrains.has(sid)) return;
  const safety = setTimeout(
    () => {
      // TTL elapsed without the handles draining — terminate as a normal end.
      pendingReleases.delete(sid);
      disarmWakeUpListener(sid);
      pendingDrains.delete(sid);
      input.terminate();
    },
    Math.max(0, input.timeoutMs),
  );
  pendingDrains.set(sid, () => {
    clearTimeout(safety);
    input.terminate();
  });
}

/**
 * End-of-turn teardown for a one-shot child session: terminate immediately
 * when nothing is pending (the historical behavior), otherwise hold the
 * session until its pending exec-notify handles drain (capped by the
 * persisted wall-clock expiry).
 */
export function settleOneShotAfterTurn(input: {
  readonly sessionManager: SessionManager;
  readonly sessions: SessionStore;
  readonly stateDb?: Database.Database;
  readonly sessionId: string;
  readonly autoApproveGate?: HitlAutoApproveGate;
  readonly subLog: Logger;
}): void {
  const sid = input.sessionId.trim();
  const terminate = (): void =>
    terminatePersistentSubagentSession(input.sessionManager, sid, undefined, input.autoApproveGate);
  const scheduler = getExecNotifyScheduler();
  const liveNotifies =
    scheduler && input.stateDb ? scheduler.countForSession(input.stateDb, sid) : 0;
  if (liveNotifies <= 0) {
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
  input.subLog.info("one-shot held for pending exec-notify handles", {
    sessionId: sid,
    liveNotifies,
    timeoutMs,
  });
}

/** Clear every hold, pending release, and delivery marker (shutdown/tests). */
export function clearAllOneShotNotifyDrains(): void {
  for (const unsubscribe of armedWakeUpListeners.values()) unsubscribe();
  armedWakeUpListeners.clear();
  pendingReleases.clear();
  deliveryInFlight.clear();
  pendingDrains.clear();
}
