-- Phase 1: per-session tool discovery state.
CREATE TABLE IF NOT EXISTS session_tool_state (
  session_id  TEXT NOT NULL,
  tool_id     TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, tool_id)
);
