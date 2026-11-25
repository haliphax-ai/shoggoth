/**
 * Change-invalidation source for the turn status bar's live sections.
 *
 * Invalidate-on-change: every mutation of the underlying state bumps a
 * per-source change counter here, and the status bar engine compares counter
 * versions on a short interval and re-reads the DB only for sections whose
 * version moved. Outside an active turn the counters are still bumped (cheap
 * monotonic integers); there is no buffer to trim. See docs/daemon.md for the
 * full render-path rationale.
 */

/** Data source whose value a live status-bar section renders. */
export type StatusBarDataSource = "timers" | "notifies" | "subagents" | "cruise" | "yolo";

/** Per-source monotonic change counters (a version that never moved renders cached). */
export type StatusBarSourceVersions = Record<StatusBarDataSource, number>;

const counters = new Map<StatusBarDataSource, number>();

/**
 * Record that the underlying data for `sources` changed (row inserted or
 * deleted, flag enabled or disabled, …). Callers that can wake a running
 * turn's bar immediately also fire the turn's change signal afterwards.
 */
export function invalidateStatusBarSources(...sources: StatusBarDataSource[]): void {
  for (const source of sources) counters.set(source, (counters.get(source) ?? 0) + 1);
}

/** Current per-source change counters (one integer each, zero-initialised). */
export function statusBarSourceVersions(): StatusBarSourceVersions {
  return {
    timers: counters.get("timers") ?? 0,
    notifies: counters.get("notifies") ?? 0,
    subagents: counters.get("subagents") ?? 0,
    cruise: counters.get("cruise") ?? 0,
    yolo: counters.get("yolo") ?? 0,
  };
}
