-- Human-in-the-loop: queued tool actions awaiting operator approval (or timeout → deny).

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
