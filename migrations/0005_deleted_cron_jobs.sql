-- Track explicitly deleted cron jobs so task.scan doesn't re-create them.
CREATE TABLE IF NOT EXISTS deleted_cron_jobs (
  cron_job_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL DEFAULT (unixepoch())
);
