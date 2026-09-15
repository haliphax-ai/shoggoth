/** Process states that indicate the process is no longer running. */
export const TERMINAL_STATES = ["dead", "exited", "failed"] as const;

/**
 * Check whether a state string is in {@link TERMINAL_STATES}.
 */
export function isTerminal(state: string): boolean {
  return TERMINAL_STATES.includes(state as (typeof TERMINAL_STATES)[number]);
}
