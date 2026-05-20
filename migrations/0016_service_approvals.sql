CREATE TABLE IF NOT EXISTS service_approvals (
  service_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_fingerprint TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);