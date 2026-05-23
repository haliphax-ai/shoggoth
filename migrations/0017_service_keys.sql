CREATE TABLE service_keys (
  service_id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
