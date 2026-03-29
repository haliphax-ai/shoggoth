-- Shoggoth v1 initial schema (iterate in later migrations).
-- Single-writer SQLite; use WAL (set by application, not this file).

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_profile_id TEXT,
  model_selection_json TEXT,
  workspace_path TEXT NOT NULL,
  runtime_uid INTEGER,
  runtime_gid INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_status ON sessions (status);

-- ---------------------------------------------------------------------------
-- Transcripts (row-per-message; large blobs can move to side table later)
-- ---------------------------------------------------------------------------
CREATE TABLE transcript_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, seq)
);

CREATE INDEX idx_transcript_session_seq ON transcript_messages (session_id, seq);

-- ---------------------------------------------------------------------------
-- Durable events / queue (global or session-scoped scope string)
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_status_next ON events (status, next_attempt_at);
CREATE INDEX idx_events_scope ON events (scope);

-- ---------------------------------------------------------------------------
-- Cron registry
-- ---------------------------------------------------------------------------
CREATE TABLE cron_jobs (
  id TEXT PRIMARY KEY,
  schedule_expr TEXT NOT NULL,
  payload_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cron_next ON cron_jobs (enabled, next_run_at);

-- ---------------------------------------------------------------------------
-- Audit log (append-oriented)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  principal_kind TEXT,
  principal_id TEXT,
  session_id TEXT,
  agent_id TEXT,
  peer_uid INTEGER,
  peer_gid INTEGER,
  peer_pid INTEGER,
  correlation_id TEXT,
  action TEXT NOT NULL,
  resource TEXT,
  outcome TEXT NOT NULL,
  args_redacted_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_created ON audit_log (created_at);
CREATE INDEX idx_audit_correlation ON audit_log (correlation_id);
CREATE INDEX idx_audit_session ON audit_log (session_id);

-- ---------------------------------------------------------------------------
-- Operator identity from SO_PEERCRED (UID → operator id / roles)
-- ---------------------------------------------------------------------------
CREATE TABLE operator_uid_map (
  uid INTEGER PRIMARY KEY,
  operator_id TEXT NOT NULL,
  roles_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Agent session credentials (store hash only at rest)
-- ---------------------------------------------------------------------------
CREATE TABLE agent_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX idx_agent_tokens_session ON agent_tokens (session_id);
CREATE UNIQUE INDEX idx_agent_tokens_hash_active ON agent_tokens (token_hash)
WHERE
  revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Retention bookkeeping (manual jobs / future automation)
-- ---------------------------------------------------------------------------
CREATE TABLE retention_metadata (
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  retained_until TEXT,
  size_bytes INTEGER,
  deleted_at TEXT,
  notes TEXT,
  PRIMARY KEY (resource_type, resource_id)
);

CREATE INDEX idx_retention_until ON retention_metadata (retained_until)
WHERE
  deleted_at IS NULL;
