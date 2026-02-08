-- Remove OpenClaw-owned fields from the tasks table.
-- Schedule, instructions, and model belong to OpenClaw (stored in ~/.openclaw/cron/jobs.json)
-- and should not be duplicated in D1 to avoid sync issues.
-- These values now come to the frontend via WebSocket task.scan.result messages.

ALTER TABLE tasks DROP COLUMN schedule;
ALTER TABLE tasks DROP COLUMN instructions;
ALTER TABLE tasks DROP COLUMN model;
