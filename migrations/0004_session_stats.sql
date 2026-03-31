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
