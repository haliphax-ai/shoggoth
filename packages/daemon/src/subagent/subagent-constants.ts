/**
 * Default inactivity window for persistent subagent sessions, in minutes (24 hours).
 * A persistent subagent is auto-terminated after this much time with no delivered
 * assistant response; every delivered response resets the clock. This applies uniformly
 * to thread-bound and threadless persistent subagents (there is no wall-clock lifetime
 * for them).
 *
 * The public surface (tool arg, CLI env var, exports) is expressed in minutes;
 * milliseconds are internal to daemon timer arithmetic only.
 */
export const SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MINUTES = 1_440;

/**
 * The default inactivity window in milliseconds, for internal timer arithmetic only
 * (arming setTimeout, computing persisted expiry timestamps).
 */
export function subagentPersistentInactivityTimeoutMs(): number {
  return SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MINUTES * 60_000;
}
