-- Add system_context_token column to sessions for anti-spoofing hardening.
ALTER TABLE sessions ADD COLUMN system_context_token TEXT DEFAULT NULL;
