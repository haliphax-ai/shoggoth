/** Runtime handles for persistent subagents (thread routing, bus subscription, TTL). */

import { clearPersistentSubagentInactivityTimer } from "./persistent-subagent-timers";

export type SubagentRuntimeHandles = {
  readonly unregisterThread: () => void;
  readonly unsubscribeBus: () => void;
  readonly clearTtl: () => void;
};

const bySession = new Map<string, SubagentRuntimeHandles>();

export function rememberSubagentHandles(sessionId: string, handles: SubagentRuntimeHandles): void {
  bySession.set(sessionId.trim(), handles);
}

/**
 * Read back the handles a flow registered for a session (e.g. a control-plane spawn
 * adopting a session the thread-create autocreate routine already wired up), so the
 * adopter reuses the live thread binding and bus subscription instead of duplicating them.
 */
export function getSubagentHandles(sessionId: string): SubagentRuntimeHandles | undefined {
  return bySession.get(sessionId.trim());
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
