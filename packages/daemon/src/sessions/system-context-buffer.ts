/**
 * Per-session in-memory buffer for system context entries injected on the next model turn.
 * Singleton — any module can import and push context; the turn drains it.
 */

const buffers = new Map<string, string[]>();

export function pushSystemContext(sessionId: string, context: string): void {
  const arr = buffers.get(sessionId);
  if (arr) arr.push(context);
  else buffers.set(sessionId, [context]);
}

/** Returns all buffered entries and clears the buffer for this session. */
export function drainSystemContext(sessionId: string): string[] {
  const arr = buffers.get(sessionId);
  if (!arr || arr.length === 0) {
    buffers.delete(sessionId);
    return [];
  }
  buffers.delete(sessionId);
  return arr;
}

/** Visible for testing — clears all buffers. */
export function _resetAllBuffers(): void {
  buffers.clear();
}
