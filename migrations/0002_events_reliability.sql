-- Event reliability, cron linkage, session fields, tool_runs for reconciliation.

ALTER TABLE sessions ADD COLUMN light_context INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN prompt_stack_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE events ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 8;
ALTER TABLE events ADD COLUMN claimed_at TEXT;

ALTER TABLE cron_jobs ADD COLUMN session_id TEXT REFERENCES sessions (id) ON DELETE CASCADE;

CREATE INDEX idx_cron_session ON cron_jobs (session_id);

-- Orphan reconciliation for in-flight tool work.
CREATE TABLE tool_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tool_runs_status ON tool_runs (status);

-- At-least-once handler completion marker (idempotent processing by event id).
CREATE TABLE event_processing_done (
  event_id INTEGER NOT NULL PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  finished_at TEXT NOT NULL DEFAULT (datetime('now'))
);
