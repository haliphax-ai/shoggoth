-- Shoggoth schema. Prototype: wipe state DB on schema change.
-- Single-writer SQLite; WAL is enabled by the application.

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
  light_context INTEGER NOT NULL DEFAULT 0,
  prompt_stack_json TEXT NOT NULL DEFAULT '[]',
  context_segment_id TEXT NOT NULL,
  parent_session_id TEXT,
  subagent_mode TEXT,
  subagent_platform_thread_id TEXT,
  subagent_expires_at_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_status ON sessions (status);
CREATE INDEX idx_sessions_parent_session ON sessions (parent_session_id);

-- ---------------------------------------------------------------------------
-- Transcripts
-- ---------------------------------------------------------------------------
CREATE TABLE transcript_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  context_segment_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  tool_calls_json TEXT DEFAULT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, seq)
);

CREATE INDEX idx_transcript_session_seq ON transcript_messages (session_id, seq);
CREATE INDEX idx_transcript_session_segment_seq ON transcript_messages (session_id, context_segment_id, seq);

-- ---------------------------------------------------------------------------
-- Durable events / queue
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
  max_attempts INTEGER NOT NULL DEFAULT 8,
  claimed_at TEXT,
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
  session_id TEXT REFERENCES sessions (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cron_next ON cron_jobs (enabled, next_run_at);
CREATE INDEX idx_cron_session ON cron_jobs (session_id);

-- ---------------------------------------------------------------------------
-- Tool runs (in-flight / reconciliation)
-- ---------------------------------------------------------------------------
CREATE TABLE tool_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  failure_reason TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tool_runs_status ON tool_runs (status);

CREATE TABLE event_processing_done (
  event_id INTEGER NOT NULL PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  finished_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Audit log
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
-- Operator identity map (UID → operator_id)
-- ---------------------------------------------------------------------------
CREATE TABLE operator_uid_map (
  uid INTEGER PRIMARY KEY,
  operator_id TEXT NOT NULL,
  roles_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Agent session credentials (hash at rest)
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
-- Retention bookkeeping
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

-- ---------------------------------------------------------------------------
-- HITL: pending tool actions
-- ---------------------------------------------------------------------------
CREATE TABLE hitl_pending_actions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  correlation_id TEXT,
  tool_name TEXT NOT NULL,
  resource_summary TEXT,
  payload_json TEXT NOT NULL,
  risk_tier TEXT NOT NULL,
  status TEXT NOT NULL,
  denial_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  resolver_principal TEXT
);

CREATE INDEX idx_hitl_pending_session_status ON hitl_pending_actions (session_id, status);
CREATE INDEX idx_hitl_pending_expires ON hitl_pending_actions (status, expires_at);

-- ---------------------------------------------------------------------------
-- HITL: session tools that skip approval
-- ---------------------------------------------------------------------------
CREATE TABLE hitl_session_tool_auto_approve (
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, tool_name)
);

CREATE INDEX idx_hitl_session_tool_auto_session ON hitl_session_tool_auto_approve (session_id);

-- ---------------------------------------------------------------------------
-- Memory index (FTS5 + optional embeddings)
-- ---------------------------------------------------------------------------
CREATE TABLE memory_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL UNIQUE,
  title TEXT,
  body TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  source_mtime_ms INTEGER,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  title,
  body,
  content = 'memory_documents',
  content_rowid = 'id'
);

CREATE TRIGGER memory_documents_ai AFTER INSERT ON memory_documents BEGIN
INSERT INTO memory_fts(rowid, title, body)
VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER memory_documents_ad AFTER DELETE ON memory_documents BEGIN
INSERT INTO memory_fts(memory_fts, rowid, title, body)
VALUES ('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER memory_documents_au AFTER UPDATE ON memory_documents BEGIN
INSERT INTO memory_fts(memory_fts, rowid, title, body)
VALUES ('delete', old.id, old.title, old.body);
INSERT INTO memory_fts(rowid, title, body)
VALUES (new.id, new.title, new.body);
END;

CREATE TABLE memory_embeddings (
  document_id INTEGER NOT NULL REFERENCES memory_documents (id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  content_sha256 TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (document_id, model_id)
);

CREATE INDEX idx_memory_embeddings_model ON memory_embeddings (model_id);

-- ---------------------------------------------------------------------------
-- ACPX workspace bindings
-- ---------------------------------------------------------------------------
CREATE TABLE acpx_workspace_bindings (
  acp_workspace_root TEXT PRIMARY KEY NOT NULL,
  shoggoth_session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  agent_principal_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_acpx_bindings_session ON acpx_workspace_bindings (shoggoth_session_id);

-- ---------------------------------------------------------------------------
-- Session stats
-- ---------------------------------------------------------------------------
CREATE TABLE session_stats (
  session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  turn_count INTEGER NOT NULL DEFAULT 0,
  compaction_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  context_window_tokens INTEGER,
  first_turn_at TEXT,
  last_turn_at TEXT,
  last_compacted_at TEXT,
  transcript_message_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
