/**
 * Per-session steer channel for injecting operator guidance into active tool
 * loops (same singleton-map pattern as system-context-buffer.ts); see
 * docs/daemon.md → "Steer Channel" for the drop and answered handshake
 * semantics that guarantee delivery.
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
  const sid = sessionId.trim();
  const queue: SteerEntry[] = [];
  const prev = channels.get(sid);
  if (prev) dropEntries(sid, prev.splice(0)); // replaced turn: undrained messages are dropped
  channels.set(sid, queue);
  let dropped = false;
  return {
    unregister: () => {
      if (channels.get(sid) === queue) channels.delete(sid);
      if (dropped) return;
      dropped = true;
      dropEntries(sid, queue.splice(0));
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
  const q = channels.get(sessionId.trim());
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
  const sid = sessionId.trim();
  const q = channels.get(sid);
  if (!q || q.length === 0) return [];
  const drained = q.splice(0).map((e) => e.message);
  const pending = unansweredBySession.get(sid) ?? [];
  pending.push(...drained);
  unansweredBySession.set(sid, pending);
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

/** Clears the session's queued channel and unanswered-steer tracking (tests, teardown). */
export function clearSteerChannel(sessionId: string): void {
  const sid = sessionId.trim();
  channels.delete(sid);
  unansweredBySession.delete(sid);
}

/** Visible for testing — clears all channels. */
export function _resetAllChannels(): void {
  channels.clear();
  unansweredBySession.clear();
}
