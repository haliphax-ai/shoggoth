-- Migration: 0010_working_directory.sql
-- Add per-session working directory (nullable; NULL means workspace root)

ALTER TABLE sessions ADD COLUMN working_directory TEXT;
