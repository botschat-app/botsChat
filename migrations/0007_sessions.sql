-- Sessions table — multiple conversation sessions per channel.
-- Each session has its own session_key so messages are isolated.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Default',
  session_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id, created_at);

-- Migrate existing channels: create a "Default" session for each channel
-- using the adhoc task's session_key for backward compatibility.
INSERT OR IGNORE INTO sessions (id, channel_id, user_id, name, session_key)
SELECT
  'ses_' || lower(hex(randomblob(8))),
  ch.id,
  ch.user_id,
  'Default',
  t.session_key
FROM channels ch
JOIN tasks t ON t.channel_id = ch.id AND t.kind = 'adhoc' AND t.session_key IS NOT NULL
GROUP BY ch.id;
