-- Promote tool_calls from metadata_json to a dedicated column.
ALTER TABLE transcript_messages ADD COLUMN tool_calls_json TEXT DEFAULT NULL;
