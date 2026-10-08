/**
 * Default inactivity window for persistent subagent sessions (24 hours). A persistent
 * subagent is auto-terminated after this much time with no delivered assistant response;
 * every delivered response resets the clock. This applies uniformly to thread-bound and
 * threadless persistent subagents (there is no wall-clock lifetime for them).
 */
export const SUBAGENT_PERSISTENT_INACTIVITY_TIMEOUT_MS = 86_400_000;
