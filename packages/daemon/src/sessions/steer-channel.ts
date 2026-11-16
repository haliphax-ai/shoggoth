/**
 * Per-session steer channel for injecting operator guidance into active tool loops.
 * Follows the same singleton-map pattern as system-context-buffer.ts.
 *
 * Pushed messages may carry an `onDropped` callback: guaranteed
 * in-turn delivery needs to know when a queued message will never reach the
 * model — the turn ended (unregister) or a new turn replaced the channel
 * before the message was drained — so the sender can fall back to another
 * delivery path (e.g. an OOB turn) instead of silently losing the message.
 *
 * Drained messages additionally get an "answered" handshake: injection
 * consumes the entry, but the consumption only counts as delivered when the
 * receiving turn settles normally (the tool loop marks it answered on
 * completion). If the turn aborts or fails first, the message stays tracked
 * as injected-but-unanswered so a teardown can re-deliver it instead of
 * dropping a directive the model never responded to.
 */
import { getLogger } from "../logging";

interface SteerEntry {
  readonly message: string;
  readonly onDropped?: () => void;
}

const channels = new Map<string, SteerEntry[]>();

/**
 * Steer messages drained into a turn but not yet answered by it, keyed by
 * session. Session-level on purpose: the channel dies with the turn that
 * received the injection, while the "was the directive answered?" question
 * outlives it.
 */
const unansweredBySession = new Map<string, string[]>();

const log = getLogger("steer-channel");

/**
 * Invokes drop callbacks and emits a warn so a never-drained steer entry is
 * visible in logs. The `onDropped` callback (when registered) remains the
 * guaranteed-delivery mechanism; this log only makes the drop itself
 * observable.
 */
function dropEntries(sessionId: string, entries: SteerEntry[]): void {
  for (const entry of entries) {
    log.warn("steer entry dropped undrained", {
      sessionId,
      content: entry.message.slice(0, 80),
    });
    try {
      entry.onDropped?.();
    } catch {
      // A drop callback is a best-effort fallback trigger; never let it
      // break channel teardown for the other queued messages.
    }
  }
}

/** Registers a steer channel for a session. Returns an unregister handle. */
export function registerSteerChannel(sessionId: string): {
  unregister: () => void;
} {
  const queue: SteerEntry[] = [];
  const prev = channels.get(sessionId);
  if (prev) dropEntries(sessionId, prev.splice(0)); // replaced turn: undrained messages are dropped
  channels.set(sessionId, queue);
  let dropped = false;
  return {
    unregister: () => {
      if (channels.get(sessionId) === queue) channels.delete(sessionId);
      if (dropped) return;
      dropped = true;
      dropEntries(sessionId, queue.splice(0));
    },
  };
}

/**
 * Pushes a steer message. Returns true if an active channel exists.
 * `onDropped` fires if the message is never drained (turn ended / replaced).
 */
export function pushSteer(
  sessionId: string,
  message: string,
  opts: { onDropped?: () => void } = {},
): boolean {
  const q = channels.get(sessionId);
  if (!q) return false;
  q.push({ message, ...(opts.onDropped ? { onDropped: opts.onDropped } : {}) });
  return true;
}

/**
 * Drains all pending steer messages for a session, marking them
 * injected-but-unanswered: the receiving turn must settle normally for the
 * injection to count as delivered (the tool loop settles on completion).
 */
export function drainSteers(sessionId: string): string[] {
  const q = channels.get(sessionId);
  if (!q || q.length === 0) return [];
  const drained = q.splice(0).map((e) => e.message);
  const pending = unansweredBySession.get(sessionId) ?? [];
  pending.push(...drained);
  unansweredBySession.set(sessionId, pending);
  return drained;
}

/**
 * Mark every injected-but-unanswered steer for the session as answered
 * (the receiving turn settled normally and a model response followed).
 */
export function settleSteersAnswered(sessionId: string): void {
  unansweredBySession.delete(sessionId.trim());
}

/** Take the outstanding unanswered steer messages (clearing the tracking). */
export function takeUnansweredSteers(sessionId: string): string[] {
  return unansweredBySession.get(sessionId.trim())?.splice(0) ?? [];
}

/**
 * Steer messages not yet answered by the model: queued (never injected) plus
 * injected-but-unanswered. One-shot teardown treats a non-zero depth as "a
 * directive may still lose its answer" and re-delivers before terminating.
 */
export function steerDepth(sessionId: string): number {
  const sid = sessionId.trim();
  return (channels.get(sid)?.length ?? 0) + (unansweredBySession.get(sid)?.length ?? 0);
}

/** Visible for testing — clears all channels. */
export function _resetAllChannels(): void {
  channels.clear();
  unansweredBySession.clear();
}
