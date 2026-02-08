import { Hono } from "hono";
import type { Env } from "../env.js";
import { generateId } from "../utils/id.js";

const channels = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

/** GET /api/channels — list all channels for the current user */
channels.get("/", async (c) => {
  const userId = c.get("userId");

  const { results } = await c.env.DB.prepare(
    "SELECT id, name, description, openclaw_agent_id, system_prompt, created_at, updated_at FROM channels WHERE user_id = ? ORDER BY created_at DESC",
  )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      description: string;
      openclaw_agent_id: string;
      system_prompt: string;
      created_at: number;
      updated_at: number;
    }>();

  return c.json({
    channels: (results ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      openclawAgentId: r.openclaw_agent_id,
      systemPrompt: r.system_prompt,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

/** POST /api/channels — create a new channel */
channels.post("/", async (c) => {
  const userId = c.get("userId");
  const { name, description, openclawAgentId, systemPrompt } = await c.req.json<{
    name: string;
    description?: string;
    openclawAgentId?: string;
    systemPrompt?: string;
  }>();

  if (!name?.trim()) {
    return c.json({ error: "Channel name is required" }, 400);
  }

  const id = generateId("ch_");
  // Default agent ID derived from channel name (slug)
  const agentId =
    openclawAgentId?.trim() ||
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  await c.env.DB.prepare(
    "INSERT INTO channels (id, user_id, name, description, openclaw_agent_id, system_prompt) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, userId, name.trim(), description?.trim() ?? "", agentId, systemPrompt?.trim() ?? "")
    .run();

  // Auto-create a default "Ad Hoc Chat" task
  const taskId = generateId("tsk_");
  const sessionKey = `agent:${agentId}:botschat:${userId}:adhoc`;
  await c.env.DB.prepare(
    "INSERT INTO tasks (id, channel_id, name, kind, session_key) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(taskId, id, "Ad Hoc Chat", "adhoc", sessionKey)
    .run();

  // Auto-create a default session
  const sessionId = generateId("ses_");
  await c.env.DB.prepare(
    "INSERT INTO sessions (id, channel_id, user_id, name, session_key) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(sessionId, id, userId, "Session 1", sessionKey)
    .run();

  return c.json(
    {
      id,
      name: name.trim(),
      description: description?.trim() ?? "",
      openclawAgentId: agentId,
      systemPrompt: systemPrompt?.trim() ?? "",
    },
    201,
  );
});

/** GET /api/channels/:id — get a single channel */
channels.get("/:id", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("id");

  const row = await c.env.DB.prepare(
    "SELECT id, name, description, openclaw_agent_id, system_prompt, created_at, updated_at FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first<{
      id: string;
      name: string;
      description: string;
      openclaw_agent_id: string;
      system_prompt: string;
      created_at: number;
      updated_at: number;
    }>();

  if (!row) return c.json({ error: "Channel not found" }, 404);

  return c.json({
    id: row.id,
    name: row.name,
    description: row.description,
    openclawAgentId: row.openclaw_agent_id,
    systemPrompt: row.system_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

/** PATCH /api/channels/:id — update a channel */
channels.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    description?: string;
    systemPrompt?: string;
  }>();

  const sets: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    sets.push("name = ?");
    values.push(body.name.trim());
  }
  if (body.description !== undefined) {
    sets.push("description = ?");
    values.push(body.description.trim());
  }
  if (body.systemPrompt !== undefined) {
    sets.push("system_prompt = ?");
    values.push(body.systemPrompt.trim());
  }

  if (sets.length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  sets.push("updated_at = unixepoch()");
  values.push(channelId, userId);

  await c.env.DB.prepare(
    `UPDATE channels SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
  )
    .bind(...values)
    .run();

  return c.json({ ok: true });
});

/** DELETE /api/channels/:id — delete a channel */
channels.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("id");

  await c.env.DB.prepare(
    "DELETE FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .run();

  return c.json({ ok: true });
});

export { channels };
