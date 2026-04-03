import type Database from "better-sqlite3";

export function insertSessionToolAutoApprove(
  db: Database.Database,
  sessionId: string,
  toolName: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO hitl_session_tool_auto_approve (session_id, tool_name)
     VALUES (@session_id, @tool_name)`,
  ).run({ session_id: sessionId.trim(), tool_name: toolName.trim() });
}

function sessionHasToolAutoApprove(
  db: Database.Database,
  sessionId: string,
  toolName: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM hitl_session_tool_auto_approve
       WHERE session_id = @sid AND tool_name = @tn LIMIT 1`,
    )
    .get({ sid: sessionId.trim(), tn: toolName.trim() }) as { ok: number } | undefined;
  return row !== undefined;
}

/** True if the canonical tool name is stored for this session (exact match). */
export function sessionHasToolAutoApproveFlexible(
  db: Database.Database,
  sessionId: string,
  toolName: string,
): boolean {
  return sessionHasToolAutoApprove(db, sessionId, toolName);
}

/** Removes all per-session tool auto-approve rows (e.g. after `session_context_new`). */
export function clearSessionToolAutoApproveForSession(db: Database.Database, sessionId: string): number {
  const r = db
    .prepare(`DELETE FROM hitl_session_tool_auto_approve WHERE session_id = @sid`)
    .run({ sid: sessionId.trim() });
  return Number(r.changes);
}

/** Deletes auto-approve rows for any of the given session ids (empty list → no-op). */
export function clearSessionToolAutoApproveForSessionIds(
  db: Database.Database,
  sessionIds: readonly string[],
): number {
  if (sessionIds.length === 0) return 0;
  const placeholders = sessionIds.map(() => "?").join(", ");
  const r = db
    .prepare(
      `DELETE FROM hitl_session_tool_auto_approve WHERE session_id IN (${placeholders})`,
    )
    .run(...sessionIds.map((s) => s.trim()));
  return Number(r.changes);
}

/** Wipes the entire session-level auto-approve table. */
export function clearAllSessionToolAutoApprove(db: Database.Database): number {
  const r = db.prepare(`DELETE FROM hitl_session_tool_auto_approve`).run();
  return Number(r.changes);
}
