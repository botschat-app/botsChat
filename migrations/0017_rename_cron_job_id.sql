-- Multi-Agent: rename openclaw_cron_job_id -> provider_job_id in tasks table
ALTER TABLE tasks RENAME COLUMN openclaw_cron_job_id TO provider_job_id;
