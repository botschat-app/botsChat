-- Multi-Agent Architecture: agents table
-- Agent = Type (engine) x Role (persona), independent of channels.

CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,                -- 'agt_xxx'
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,                   -- display name: "OpenClaw", "Cursor", "PM小明"
  type              TEXT NOT NULL CHECK (type IN ('openclaw', 'cursor_cli', 'cursor_cloud', 'claude_code', 'mock')),
  -- Role & Skills
  role              TEXT NOT NULL DEFAULT 'general',  -- 'product_manager', 'developer', 'qa', 'devops', 'general'
  system_prompt     TEXT NOT NULL DEFAULT '',
  skills_json       TEXT NOT NULL DEFAULT '[]',       -- JSON: [{"name":"...","description":"..."}]
  -- Connection credentials (provider-specific, at most one populated)
  pairing_token     TEXT,                             -- OpenClaw bc_pat_xxx
  api_key           TEXT,                             -- Cursor / Claude API key
  config_json       TEXT NOT NULL DEFAULT '{}',       -- extra: { workspace, repository, ref, ... }
  -- Technical capabilities (derived from type)
  capabilities      TEXT NOT NULL DEFAULT '["chat"]', -- JSON: ["chat","streaming","cron","a2ui","media","code_edit","delegate"]
  -- Runtime state
  status            TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
  last_connected_at INTEGER,
  connection_count  INTEGER NOT NULL DEFAULT 0,
  last_ip           TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_pairing_token ON agents(pairing_token) WHERE pairing_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key) WHERE api_key IS NOT NULL;
