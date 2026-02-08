-- Messages table — persists chat messages for history
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  thread_id TEXT,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'agent')),
  text TEXT NOT NULL DEFAULT '',
  media_url TEXT,
  a2ui TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
