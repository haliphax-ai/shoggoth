-- Background-exec completion notification handles (issue #478).
CREATE TABLE IF NOT EXISTS exec_notifies (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  exec_session_id TEXT NOT NULL,
  pid             INTEGER NOT NULL DEFAULT 0,
  command         TEXT NOT NULL DEFAULT '',
  options         TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  fired           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_exec_notifies_session ON exec_notifies (session_id, fired);
