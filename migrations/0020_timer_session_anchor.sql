-- anchor timers to sessions so they auto-cancel on session termination
ALTER TABLE timers ADD COLUMN session_anchor TEXT;
CREATE INDEX IF NOT EXISTS idx_timers_anchor ON timers (session_anchor, fired);