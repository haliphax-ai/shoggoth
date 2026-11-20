// re-read-required — line-shift gate for builtin-read/write/replace (stops
// edits with stale line numbers): replace marks, write/replace checks and
// gates, read clears per segment; segment resets clear all rows.

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
export function clearSessionReReadRequired(db: Database.Database, sessionId: string): void {
  db.prepare(`DELETE FROM re_read_required WHERE session_id = ?`).run(sessionId);
}
