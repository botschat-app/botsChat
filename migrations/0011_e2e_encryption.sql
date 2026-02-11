-- E2E Encryption: rebuild messages and jobs tables with BLOB columns + encrypted flag.
-- WARNING: This migration drops all existing data in messages and jobs tables.

DROP TABLE IF EXISTS messages;
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  thread_id TEXT,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'agent')),
  text BLOB,
  media_url TEXT,
  a2ui BLOB,
  encrypted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

DROP TABLE IF EXISTS jobs;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'skipped')),
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER,
  duration_ms INTEGER,
  summary BLOB,
  encrypted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_jobs_task ON jobs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_key);
