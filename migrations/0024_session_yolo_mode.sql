-- Yolo mode: persistent per-session HITL bypass flag (no expiry; cleared by the operator).
CREATE TABLE IF NOT EXISTS session_yolo_mode (
  session_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);