-- Persist shutdown / error reason on tool runs.

ALTER TABLE tool_runs ADD COLUMN failure_reason TEXT;
