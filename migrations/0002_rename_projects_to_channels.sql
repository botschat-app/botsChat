-- Rename projects → channels and project_id → channel_id
-- Full recreation since SQLite doesn't support ALTER COLUMN RENAME

-- Create channels table matching projects schema
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  openclaw_agent_id TEXT NOT NULL,
  system_prompt TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Drop old projects table if it still exists
DROP TABLE IF EXISTS projects;

-- Recreate tasks table with channel_id instead of project_id
DROP TABLE IF EXISTS tasks;
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('background', 'adhoc')),
  openclaw_cron_job_id TEXT,
  schedule TEXT,
  instructions TEXT,
  session_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Recreate threads table with corrected references
DROP TABLE IF EXISTS threads;
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_message_id TEXT NOT NULL,
  thread_session_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Ensure indexes exist
CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id);
CREATE INDEX IF NOT EXISTS idx_threads_task ON threads(task_id);

-- Cleanup old indexes
DROP INDEX IF EXISTS idx_projects_user;
DROP INDEX IF EXISTS idx_tasks_project;
DROP INDEX IF EXISTS idx_skill_usage_user_project;
