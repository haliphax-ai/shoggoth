/** Runtime handles for persistent subagents (thread routing, bus subscription, TTL). */

type SubagentRuntimeHandles = {
  readonly unregisterThread: () => void;
  readonly unsubscribeBus: () => void;
  readonly clearTtl: () => void;
};

const bySession = new Map<string, SubagentRuntimeHandles>();

export function rememberSubagentHandles(sessionId: string, handles: SubagentRuntimeHandles): void {
  bySession.set(sessionId.trim(), handles);
}

export function disposeSubagentRuntime(sessionId: string): void {
  const sid = sessionId.trim();
  const h = bySession.get(sid);
  if (!h) return;
  try {
    h.clearTtl();
  } catch {
    /* ignore */
  }
  try {
    h.unregisterThread();
  } catch {
    /* ignore */
  }
  try {
    h.unsubscribeBus();
  } catch {
    /* ignore */
  }
  bySession.delete(sid);
}
