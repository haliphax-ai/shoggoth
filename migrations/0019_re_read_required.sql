-- Tracks files that have been modified (via builtin-replace) in the current
-- context segment, with line numbers potentially shifted. Subsequent
-- builtin-write or builtin-replace calls against a flagged file are gated
-- until the agent re-reads the file with builtin-read. Rows are cleared on
-- context segment new/reset (see session-context-segment.ts).
CREATE TABLE IF NOT EXISTS re_read_required (
  session_id         TEXT    NOT NULL,
  context_segment_id TEXT    NOT NULL,
  file_path          TEXT    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, context_segment_id, file_path)
);

CREATE INDEX IF NOT EXISTS re_read_required_session_idx
  ON re_read_required (session_id);
