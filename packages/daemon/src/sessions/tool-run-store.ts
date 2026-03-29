import type Database from "better-sqlite3";

export interface ToolRunStore {
  insertRunning(input: { id: string; sessionId: string }): void;
  markCompleted(id: string): void;
  markFailed(id: string, reason: string): void;
  markAllRunningFailed(reason: string): number;
}

export function createToolRunStore(db: Database.Database): ToolRunStore {
  const insert = db.prepare(`
    INSERT INTO tool_runs (id, session_id, status, started_at, updated_at)
    VALUES (@id, @session_id, 'running', datetime('now'), datetime('now'))
  `);

  return {
    insertRunning(input) {
      insert.run({ id: input.id, session_id: input.sessionId });
    },

    markCompleted(id) {
      db.prepare(
        `
        UPDATE tool_runs SET status = 'completed', updated_at = datetime('now'), failure_reason = NULL
        WHERE id = @id
      `,
      ).run({ id });
    },

    markFailed(id, reason) {
      db.prepare(
        `
        UPDATE tool_runs SET status = 'failed', failure_reason = @reason, updated_at = datetime('now')
        WHERE id = @id
      `,
      ).run({ id, reason });
    },

    markAllRunningFailed(reason) {
      const r = db
        .prepare(
          `
        UPDATE tool_runs SET status = 'failed', failure_reason = @reason, updated_at = datetime('now')
        WHERE status = 'running'
      `,
        )
        .run({ reason });
      return r.changes;
    },
  };
}
