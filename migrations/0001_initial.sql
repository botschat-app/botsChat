-- BotsChat D1 Schema
-- Initial migration: users, projects, tasks, threads, skill usage, voice keywords

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  settings_json TEXT DEFAULT '{}',  -- voice keywords, STT API key, etc.
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS pairing_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,       -- bc_pat_xxxxxxxx
  label TEXT,                        -- user-assigned label
  last_connected_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_pairing_tokens_user ON pairing_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_pairing_tokens_token ON pairing_tokens(token);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  openclaw_agent_id TEXT NOT NULL,   -- maps to OpenClaw agent ID
  system_prompt TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('background', 'adhoc')),
  openclaw_cron_job_id TEXT,         -- for background tasks
  schedule TEXT,                      -- cron expression or preset
  instructions TEXT,                  -- agent instructions per run
  session_key TEXT,                   -- for adhoc: the OpenClaw session key
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_message_id TEXT NOT NULL,
  thread_session_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_threads_task ON threads(task_id);

CREATE TABLE IF NOT EXISTS skill_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, project_id, skill_name)
);
CREATE INDEX IF NOT EXISTS idx_skill_usage_user_project ON skill_usage(user_id, project_id);

CREATE TABLE IF NOT EXISTS voice_keywords (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'auto-learned')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_voice_keywords_user ON voice_keywords(user_id);

-- FTS5 virtual table for chat history search (hashtag cross-reference)
-- Messages are synced from OpenClaw session transcripts on demand.
CREATE VIRTUAL TABLE IF NOT EXISTS chat_search USING fts5(
  session_key,
  sender,
  content,
  timestamp UNINDEXED
);
