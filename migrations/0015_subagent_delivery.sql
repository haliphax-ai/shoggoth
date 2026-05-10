-- Add delivery_mode and respond_to columns for subagent result delivery.
ALTER TABLE sessions ADD COLUMN subagent_delivery_mode TEXT;
ALTER TABLE sessions ADD COLUMN subagent_respond_to TEXT;
