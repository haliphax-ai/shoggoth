/**
 * Shared inactivity timer for persistent subagent sessions.
 *
 * Every persistent subagent (thread-bound or threadless, regardless of spawn path) is
 * terminated after an inactivity window with no delivered assistant response. The clock
 * starts at arm time, is re-armed by `touchPersistentSubagentInactivityTimer` after each
 * delivered response, and the computed expiry is persisted (`subagentExpiresAtMs`) so the
 * startup reconcile re-arms the remaining window after a restart.
 *
 * Spawn, autocreate, and reconcile all arm through this module so there is exactly one
 * arm/reset implementation. `disposeSubagentRuntime` (via the `clearTtl` handle each
 * arming site registers) tears the timer down on kill.
 */

import { getLogger } from "../logging";
import type { SessionStore } from "../sessions/session-store";
import { SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS } from "./subagent-constants";

const log = getLogger("persistent-subagent-timers");

export type PersistentSubagentTimerDeps = {
  readonly sessions: SessionStore;
  readonly onTimeout: (sessionId: string) => void;
};

type TimerEntry = {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly timeoutMs: number;
  readonly deps: PersistentSubagentTimerDeps;
};

const bySession = new Map<string, TimerEntry>();

export type ArmPersistentSubagentTimerOptions = {
  /**
   * Inactivity window used for this arm and for subsequent touch() re-arms.
   * Defaults to SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS.
   */
  readonly timeoutMs?: number;
  /**
   * Absolute expiry to honor (e.g. a persisted value restored by the startup reconcile
   * so the remaining window survives a restart). Defaults to now + timeoutMs.
   */
  readonly expiresAtMs?: number;
  /** Injectable clock (tests). */
  readonly now?: number;
};

/**
 * Arm (or re-arm) the session's inactivity timer. Clears any previously armed timer,
 * persists the computed expiry via SessionStore, and schedules the timeout. Returns the
 * persisted expiry and a disposer that clears the timer (wire it as the runtime
 * handle's `clearTtl` so kills tear it down).
 */
export function armPersistentSubagentInactivityTimer(
  deps: PersistentSubagentTimerDeps,
  sessionId: string,
  options?: ArmPersistentSubagentTimerOptions,
): { readonly expiresAtMs: number; readonly dispose: () => void } {
  const sid = sessionId.trim();
  clearPersistentSubagentInactivityTimer(sid);
  const timeoutMs = options?.timeoutMs ?? SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS;
  const now = options?.now ?? Date.now();
  const expiresAtMs = options?.expiresAtMs ?? now + timeoutMs;
  try {
    deps.sessions.update(sid, { subagentExpiresAtMs: expiresAtMs });
  } catch (e) {
    log.warn("subagent.inactivity.expiry_persist_failed", { sessionId: sid, err: String(e) });
  }
  const timer = setTimeout(
    () => {
      bySession.delete(sid);
      deps.onTimeout(sid);
    },
    Math.max(0, expiresAtMs - now),
  );
  bySession.set(sid, { timer, timeoutMs, deps });
  return { expiresAtMs, dispose: () => clearPersistentSubagentInactivityTimer(sid) };
}

/**
 * Reset the inactivity clock after a delivered assistant response: re-arms the timer
 * for a full timeout window and persists the new expiry. No-op when the session has no
 * armed inactivity timer (e.g. one-shot subagents or regular sessions).
 */
export function touchPersistentSubagentInactivityTimer(sessionId: string): void {
  const sid = sessionId.trim();
  const entry = bySession.get(sid);
  if (!entry) return;
  armPersistentSubagentInactivityTimer(entry.deps, sid, { timeoutMs: entry.timeoutMs });
}

/** Clear the armed inactivity timer (if any) without touching anything else. */
export function clearPersistentSubagentInactivityTimer(sessionId: string): void {
  const sid = sessionId.trim();
  const entry = bySession.get(sid);
  if (!entry) return;
  clearTimeout(entry.timer);
  bySession.delete(sid);
}

/** Clear every armed inactivity timer (shutdown/tests). */
export function clearAllPersistentSubagentInactivityTimers(): void {
  for (const entry of bySession.values()) {
    clearTimeout(entry.timer);
  }
  bySession.clear();
}
