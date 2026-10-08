/** Runtime handles for persistent subagents (thread routing, bus subscription, TTL). */

import { clearPersistentSubagentInactivityTimer } from "./persistent-subagent-timers";

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
  // Belt-and-suspenders: clear the shared inactivity timer even if the handles map
  // was lost (the armed handle's clearTtl is the same clear, kept for symmetry).
  clearPersistentSubagentInactivityTimer(sid);
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
