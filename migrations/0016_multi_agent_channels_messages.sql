-- Multi-Agent Architecture: extend channels and messages for multi-agent support.

-- Channels: add default agent + rename openclaw-specific column
ALTER TABLE channels ADD COLUMN default_agent_id TEXT REFERENCES agents(id);
ALTER TABLE channels RENAME COLUMN openclaw_agent_id TO provider_agent_id;

-- Messages: track which agent sent/received each message
ALTER TABLE messages ADD COLUMN sender_agent_id TEXT REFERENCES agents(id);
ALTER TABLE messages ADD COLUMN target_agent_id TEXT REFERENCES agents(id);
