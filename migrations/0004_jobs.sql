-- Jobs table — caches background task execution history from OpenClaw CronService
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'skipped')),
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER,
  duration_ms INTEGER,
  summary TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_jobs_task ON jobs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_key);
