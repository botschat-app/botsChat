-- Multi-Agent Architecture: message_traces table
-- Stores agent execution traces at different verbosity levels.
-- lv1 = conclusions (stored in messages table)
-- lv2 = thinking / reasoning process
-- lv3 = reference material / tool call results

CREATE TABLE IF NOT EXISTS message_traces (
  id              TEXT PRIMARY KEY,               -- 'mt_xxx'
  message_id      TEXT NOT NULL,                  -- parent lv1 message (messages.id)
  user_id         TEXT NOT NULL,
  session_key     TEXT NOT NULL,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  verbose_level   INTEGER NOT NULL CHECK (verbose_level IN (2, 3)),
  trace_type      TEXT NOT NULL,
  -- lv2: 'thinking', 'planning', 'reasoning', 'decision'
  -- lv3: 'file_read', 'file_write', 'command_exec', 'search_result', 'tool_call', 'reference'
  content         BLOB NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  -- lv3 file_read:    { "path": "src/auth.ts", "lines": 42 }
  -- lv3 command_exec: { "command": "npm test", "exitCode": 0 }
  -- lv3 file_write:   { "path": "src/auth.ts", "linesChanged": 5 }
  encrypted       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_traces_message ON message_traces(message_id);
CREATE INDEX IF NOT EXISTS idx_traces_session_level ON message_traces(session_key, verbose_level, created_at);
CREATE INDEX IF NOT EXISTS idx_traces_agent ON message_traces(agent_id, created_at);
