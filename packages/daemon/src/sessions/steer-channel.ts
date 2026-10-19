/**
 * Per-session steer channel for injecting operator guidance into active tool loops.
 * Follows the same singleton-map pattern as system-context-buffer.ts.
 *
 * Pushed messages may carry an `onDropped` callback: guaranteed
 * in-turn delivery needs to know when a queued message will never reach the
 * model — the turn ended (unregister) or a new turn replaced the channel
 * before the message was drained — so the sender can fall back to another
 * delivery path (e.g. an OOB turn) instead of silently losing the message.
 */

interface SteerEntry {
  readonly message: string;
  readonly onDropped?: () => void;
}

const channels = new Map<string, SteerEntry[]>();

/** Invoke drop callbacks without letting one failure orphan the rest. */
function dropEntries(entries: SteerEntry[]): void {
  for (const entry of entries) {
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
  if (prev) dropEntries(prev.splice(0)); // replaced turn: undrained messages are dropped
  channels.set(sessionId, queue);
  let dropped = false;
  return {
    unregister: () => {
      if (channels.get(sessionId) === queue) channels.delete(sessionId);
      if (dropped) return;
      dropped = true;
      dropEntries(queue.splice(0));
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

/** Drains all pending steer messages for a session. */
export function drainSteers(sessionId: string): string[] {
  const q = channels.get(sessionId);
  if (!q || q.length === 0) return [];
  return q.splice(0).map((e) => e.message);
}

/** Visible for testing — clears all channels. */
export function _resetAllChannels(): void {
  channels.clear();
}
