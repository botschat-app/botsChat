-- Multi-Agent Architecture: agent_sessions mapping table
-- Maps BotsChat sessions to each agent's provider-side session identifier.
-- e.g. BotsChat ses_001 x Cursor agent -> Cursor chatId "abc-123"

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                    TEXT PRIMARY KEY,       -- 'as_xxx'
  session_id            TEXT NOT NULL,          -- BotsChat session (ses_xxx)
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider_session_id   TEXT,                   -- provider-specific session ID
  -- OpenClaw: session_key "agent:main:botschat:u_xxx:ses:ses_xxx"
  -- Cursor CLI: chatId (uuid from `agent create-chat`)
  -- Cursor Cloud: cloud agent id "bc_xxx"
  metadata_json         TEXT NOT NULL DEFAULT '{}',
  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(session_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_session ON agent_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id);
