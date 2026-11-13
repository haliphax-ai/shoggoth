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
// keep their delivery path (in-turn steer or the OOB turn). The last handle to
// resolve — or the operator killing the session — drains the hold and
// terminates the session. A safety timer derived from the session's persisted
// wall-clock TTL caps the wait so the hold can never outlive the spawn's
// budget (the one-shot "never forever" guarantee still applies).

import type Database from "better-sqlite3";
import type { HitlAutoApproveGate } from "../hitl/hitl-auto-approve";
import type { Logger } from "../logging";
import { getExecNotifyScheduler } from "../exec/exec-notify-scheduler";
import type { SessionManager } from "../sessions/session-manager";
import type { SessionStore } from "../sessions/session-store";
import { terminatePersistentSubagentSession } from "./subagent-kill";

/** Fallback cap for the hold when the session row carries no valid expiry. */
const DEFAULT_ONE_SHOT_NOTIFY_DRAIN_TIMEOUT_MS = 60 * 60_000;

/** Terminate callbacks for held one-shot sessions, keyed by session id. */
export const pendingDrains = new Map<string, () => void>();

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
      // Safety expiry: the persisted wall-clock TTL (or the fallback cap)
      // elapsed without the handles draining — terminate as a normal TTL end.
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
 * Called after an exec-notify handle resolves or is cancelled: when the
 * session has no live handles left and is held, terminate it. A positive
 * `liveCount` (e.g. the delivery turn backgrounded new execs) keeps the hold.
 */
export function releaseOneShotIfDrained(sessionId: string, liveCount: number): void {
  const sid = sessionId.trim();
  const terminate = pendingDrains.get(sid);
  if (!terminate) return;
  if (liveCount > 0) return;
  // Delete before terminating so the kill's own cancelBySession → listener
  // round-trip is a no-op.
  pendingDrains.delete(sid);
  terminate();
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

/** Clear every hold (shutdown/tests). */
export function clearAllOneShotNotifyDrains(): void {
  pendingDrains.clear();
}
