import { Hono } from "hono";
import type { Env } from "../env.js";

/**
 * Agents API — OpenClaw-aligned first-level entity.
 * Returns the default agent (always) plus one agent per channel (default session = first adhoc task).
 */
const agents = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

export type Agent = {
  id: string;
  name: string;
  sessionKey: string;
  isDefault: boolean;
  channelId: string | null;
};

/** GET /api/agents — list agents: default + one per channel with default session */
agents.get("/", async (c) => {
  const userId = c.get("userId");

  const list: Agent[] = [];

  // 1. Channel-based agents (each channel = one agent, default session = first adhoc task)
  const { results: channels } = await c.env.DB.prepare(
    "SELECT id, name, openclaw_agent_id FROM channels WHERE user_id = ? ORDER BY created_at ASC",
  )
    .bind(userId)
    .all<{ id: string; name: string; openclaw_agent_id: string }>();

  // Find the "General" channel to associate with the default agent (for session support).
  // If the user has created a "General" channel (auto-created on first session "+"),
  // link it to the default agent so sessions work.
  const generalChannel = (channels ?? []).find((ch) => ch.name === "General");

  // Always show the "general" default agent for ad-hoc chat.
  list.push({
    id: "default",
    name: "General",
    sessionKey: `agent:main:botschat:${userId}:default`,
    isDefault: true,
    channelId: generalChannel?.id ?? null,
  });

  for (const ch of channels ?? []) {
    // Skip the "General" channel — it's linked to the default agent above
    if (generalChannel && ch.id === generalChannel.id) continue;
    const task = await c.env.DB.prepare(
      "SELECT session_key FROM tasks WHERE channel_id = ? AND kind = 'adhoc' AND session_key IS NOT NULL ORDER BY created_at ASC LIMIT 1",
    )
      .bind(ch.id)
      .first<{ session_key: string }>();

    const sessionKey =
      task?.session_key ?? `agent:${ch.openclaw_agent_id}:botschat:${userId}:adhoc`;
    list.push({
      id: ch.id,
      name: ch.name,
      sessionKey,
      isDefault: false,
      channelId: ch.id,
    });
  }

  return c.json({ agents: list });
});

export { agents };
