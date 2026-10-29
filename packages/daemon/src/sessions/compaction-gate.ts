/**
 * Per-session compaction gate for deferring manual compaction requests into an
 * active tool loop (the steer-channel pattern: singleton map, one queue per
 * session).
 *
 * Compaction rewrites the session transcript while the model client holds the
 * same messages in memory, so it must only run when the loop is parked at a
 * logical break (top of round, after steering injection, after the loop) and
 * the turn queue is frozen behind the in-flight turn. A compaction request
 * parked here is drained by the loop at the next break; a request that arrives
 * with no active loop returns undefined and the caller falls back to running
 * the compaction as a queued turn instead.
 */

import type { compactSessionTranscript } from "../transcript-compact";

/** Result of a deferred compaction run (mirrors `compactSessionTranscript`). */
export type DeferredCompactionResult = Awaited<ReturnType<typeof compactSessionTranscript>>;

interface GateEntry {
  readonly resolve: (result: DeferredCompactionResult) => void;
  reject: (err: Error) => void;
}

const gates = new Map<string, GateEntry[]>();

/** Reject parked requests without letting one failure orphan the rest. */
function rejectEntries(entries: GateEntry[], err: Error): void {
  for (const entry of entries) {
    entry.reject(err);
  }
}

/** Handle returned by {@link registerCompactionGate}. */
export type CompactionGate = ReturnType<typeof registerCompactionGate>;

/**
 * Registers a compaction gate for a session. Returns a drain handle; call
 * `unregister()` when the turn settles — leftover parked requests are rejected
 * with {@link CompactionGateClosedError} so the caller can fall back to a
 * queued compaction turn.
 */
export function registerCompactionGate(sessionId: string): {
  /** All parked compaction requests for the session, drained in order. */
  drain: () => GateEntry[];
  /** Reject leftovers and tear the gate down (idempotent per registration). */
  unregister: () => void;
} {
  const queue: GateEntry[] = [];
  const prev = gates.get(sessionId);
  if (prev) rejectEntries(prev.splice(0), new CompactionGateClosedError());
  gates.set(sessionId, queue);
  let closed = false;
  return {
    drain: () => (closed ? [] : queue.splice(0)),
    unregister: () => {
      if (gates.get(sessionId) === queue) gates.delete(sessionId);
      if (closed) return;
      closed = true;
      rejectEntries(queue.splice(0), new CompactionGateClosedError());
    },
  };
}

/**
 * Parks a compaction request for the session's active tool loop to run at its
 * next logical break. Returns the compaction promise when a gate is active
 * (the loop will run the compaction between rounds), or undefined when no
 * loop is active (the caller runs the compaction itself, behind the turn
 * queue).
 */
export function pushCompactionRequest(
  sessionId: string,
): Promise<DeferredCompactionResult> | undefined {
  const q = gates.get(sessionId);
  if (!q) return undefined;
  return new Promise<DeferredCompactionResult>((resolve, reject) => {
    q.push({ resolve, reject });
  });
}

/** Visible for testing — clears all gates. */
export function _resetAllCompactionGates(): void {
  for (const queue of gates.values()) {
    rejectEntries(queue.splice(0), new CompactionGateClosedError("compaction gate reset"));
  }
  gates.clear();
}

/** A parked compaction request will never run: the gate closed (turn ended). */
export class CompactionGateClosedError extends Error {
  constructor(message = "compaction gate closed: turn ended") {
    super(message);
    this.name = "CompactionGateClosedError";
  }
}
