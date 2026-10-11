-- provider-reported prompt-cache usage split + provider-based context-fill gauge
ALTER TABLE session_stats ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_stats ADD COLUMN cache_write_input_tokens INTEGER NOT NULL DEFAULT 0;
-- total input+output tokens of the most recent provider-reported model call
-- (gauge, not cumulative); NULL until the first provider usage arrives
ALTER TABLE session_stats ADD COLUMN context_fill_tokens INTEGER;
