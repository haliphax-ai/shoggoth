-- Persist the human-readable shorthand for subagent sessions.
ALTER TABLE sessions ADD COLUMN agent_id TEXT;
CREATE INDEX idx_sessions_agent_id ON sessions (agent_id);
