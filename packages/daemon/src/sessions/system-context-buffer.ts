/**
 * Per-session in-memory buffer for system context entries injected on the next model turn.
 * Singleton — any module can import and push context; the turn drains it.
 *
 * Entries carry a timestamp; a periodic sweep removes stale buffers whose last
 * push was longer ago than `STALE_TTL_MS`. This prevents unbounded growth when
 * sessions are created but never receive a turn (or are terminated without
 * draining).
 */

const STALE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // sweep every 60 s

interface BufferEntry {
  entries: string[];
  lastPushAt: number;
}

const buffers = new Map<string, BufferEntry>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function startSweepIfNeeded(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of buffers) {
      if (now - entry.lastPushAt > STALE_TTL_MS) {
        buffers.delete(sid);
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Allow the process to exit even if the timer is still running.
  if (sweepTimer && typeof sweepTimer === "object" && "unref" in sweepTimer) {
    sweepTimer.unref();
  }
}

export function pushSystemContext(sessionId: string, context: string): void {
  const existing = buffers.get(sessionId);
  if (existing) {
    existing.entries.push(context);
    existing.lastPushAt = Date.now();
  } else {
    buffers.set(sessionId, { entries: [context], lastPushAt: Date.now() });
  }
  startSweepIfNeeded();
}

/** Returns all buffered entries and clears the buffer for this session. */
export function drainSystemContext(sessionId: string): string[] {
  const entry = buffers.get(sessionId);
  if (!entry || entry.entries.length === 0) {
    buffers.delete(sessionId);
    return [];
  }
  buffers.delete(sessionId);
  return entry.entries;
}

/** Visible for testing — clears all buffers and stops the sweep timer. */
export function _resetAllBuffers(): void {
  buffers.clear();
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
