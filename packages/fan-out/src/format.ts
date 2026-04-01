/**
 * Format a millisecond duration as a human-readable string.
 *
 * - Under 60s:  `Xs`    (e.g. `20s`)
 * - Under 60m:  `XmYs`  (e.g. `1m5s`)
 * - 60m+:       `XhYm`  (e.g. `1h3m`)
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);

  if (totalMinutes < 1) {
    return `${totalSeconds}s`;
  }
  if (totalMinutes < 60) {
    const secs = totalSeconds % 60;
    return `${totalMinutes}m${secs}s`;
  }
  const mins = totalMinutes % 60;
  return `${totalHours}h${mins}m`;
}
