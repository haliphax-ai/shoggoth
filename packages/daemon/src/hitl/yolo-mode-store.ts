import type Database from "better-sqlite3";

/**
 * Yolo mode: a flag stamped on a session for its lifetime (persisted, no
 * expiry) that bypasses the risk-tier HITL approval queue by auto-approving
 * every queued candidate. Unlike elevation, commands still route normally and
 * execute as the agent — only the HITL queue is short-circuited. Policy
 * hard-denies, policy `requires_review` verdicts, system gates, and elevation
 * behavior are unaffected.
 *
 * Turning the flag on upserts a row; turning it off deletes the row.
 */
export function createYoloModeStore(db: Database.Database) {
  return {
    isEnabled(sessionId: string): boolean {
      const row = db
        .prepare(`SELECT enabled FROM session_yolo_mode WHERE session_id = ?`)
        .get(sessionId) as { enabled: number } | undefined;
      return row != null && row.enabled === 1;
    },

    setEnabled(sessionId: string, enabled: boolean): void {
      if (enabled) {
        db.prepare(
          `INSERT INTO session_yolo_mode (session_id, enabled, updated_at)
           VALUES (@sessionId, 1, datetime('now'))
           ON CONFLICT(session_id) DO UPDATE SET
             enabled = 1,
             updated_at = datetime('now')`,
        ).run({ sessionId });
        return;
      }
      db.prepare(`DELETE FROM session_yolo_mode WHERE session_id = ?`).run(sessionId);
    },

    getStatus(sessionId: string): { enabled: boolean; updatedAt?: string } {
      const row = db
        .prepare(`SELECT enabled, updated_at FROM session_yolo_mode WHERE session_id = ?`)
        .get(sessionId) as { enabled: number; updated_at: string } | undefined;
      if (!row) return { enabled: false };
      return { enabled: row.enabled === 1, updatedAt: row.updated_at };
    },
  };
}
