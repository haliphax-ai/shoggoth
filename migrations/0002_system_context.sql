-- Add system_context_json column to transcript_messages for trusted system context storage.
ALTER TABLE transcript_messages ADD COLUMN system_context_json TEXT DEFAULT NULL;
