// ---------------------------------------------------------------------------
// re-read-required — line-shift gate for builtin-read/write/replace
// ---------------------------------------------------------------------------
//
// Goal: stop the agent from editing a file using stale line numbers.
//
// Producer (builtin-replace): after a successful non-dry-run modification
// that may have shifted line numbers, mark the file as needing a re-read.
//
// Consumer (builtin-write, builtin-replace): before applying, check the
// current segment. If the file is flagged, return a `gated: true` payload
// asking the agent to re-read first.
//
// Clear (builtin-read): a successful content read of the file removes the
// flag for the current segment.
//
// Segment reset: applySessionContextSegmentNew/Reset clears all rows for
// the session. The new context_segment_id is naturally invisible to the
// old rows, but explicit deletion keeps the table from growing across
// resets and matches the spec's "list should be emptied" wording.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

export interface ReReadRequiredGate {
  readonly gated: true;
  readonly message: string;
  readonly filePath: string;
}

const GATE_MESSAGE =
  "File has changed since you last read it. Re-read the file (or the relevant section) with `builtin-read` and retry your edit. After reading, line numbers in your context will be valid again.";

/**
 * Mark `filePath` as needing a re-read for the given context segment.
 * Idempotent: re-marking the same triple is a no-op.
 */
export function markReReadRequired(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
  filePath: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO re_read_required
       (session_id, context_segment_id, file_path)
     VALUES (?, ?, ?)`,
  ).run(sessionId, contextSegmentId, filePath);
}

/**
 * Look up whether `filePath` is flagged in the given session and segment.
 * Returns a gate result if blocked, `null` otherwise.
 */
export function checkReReadRequired(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
  filePath: string,
): ReReadRequiredGate | null {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM re_read_required
         WHERE session_id = ? AND context_segment_id = ? AND file_path = ?`,
    )
    .get(sessionId, contextSegmentId, filePath) as { hit: number } | undefined;
  if (!row) return null;
  return { gated: true, message: GATE_MESSAGE, filePath };
}

/**
 * Remove the re-read flag for the given (session, segment, file) triple.
 * No-op if the row does not exist.
 */
export function clearReReadRequired(
  db: Database.Database,
  sessionId: string,
  contextSegmentId: string,
  filePath: string,
): void {
  db.prepare(
    `DELETE FROM re_read_required
       WHERE session_id = ? AND context_segment_id = ? AND file_path = ?`,
  ).run(sessionId, contextSegmentId, filePath);
}

/**
 * Remove every re-read flag for the given session, across all segments.
 * Called when a new context segment is generated (or reset) so the new
 * segment starts with an empty list.
 */
export function clearSessionReReadRequired(
  db: Database.Database,
  sessionId: string,
): void {
  db.prepare(`DELETE FROM re_read_required WHERE session_id = ?`).run(sessionId);
}
