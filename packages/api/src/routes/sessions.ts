import { Hono } from "hono";
import type { Env } from "../env.js";
import { generateId } from "../utils/id.js";

const sessions = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

/** GET /api/channels/:channelId/sessions — list all sessions for a channel */
sessions.get("/", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("channelId");

  // Verify channel ownership
  const channel = await c.env.DB.prepare(
    "SELECT id, openclaw_agent_id FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first<{ id: string; openclaw_agent_id: string }>();

  if (!channel) return c.json({ error: "Channel not found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT id, name, session_key, created_at, updated_at FROM sessions WHERE channel_id = ? AND user_id = ? ORDER BY created_at ASC",
  )
    .bind(channelId, userId)
    .all<{
      id: string;
      name: string;
      session_key: string;
      created_at: number;
      updated_at: number;
    }>();

  return c.json({
    sessions: (results ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      sessionKey: r.session_key,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

/** POST /api/channels/:channelId/sessions — create a new session */
sessions.post("/", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("channelId");

  // Verify channel ownership
  const channel = await c.env.DB.prepare(
    "SELECT id, openclaw_agent_id FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first<{ id: string; openclaw_agent_id: string }>();

  if (!channel) return c.json({ error: "Channel not found" }, 404);

  const { name } = await c.req.json<{ name?: string }>();

  // Count existing sessions for auto-naming
  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM sessions WHERE channel_id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first<{ cnt: number }>();
  const count = countRow?.cnt ?? 0;

  const sessionName = name?.trim() || `Session ${count + 1}`;
  const id = generateId("ses_");
  const sessionKey = `agent:${channel.openclaw_agent_id}:botschat:${userId}:ses:${id}`;

  await c.env.DB.prepare(
    "INSERT INTO sessions (id, channel_id, user_id, name, session_key) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, channelId, userId, sessionName, sessionKey)
    .run();

  return c.json(
    {
      id,
      name: sessionName,
      sessionKey,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    },
    201,
  );
});

/** PATCH /api/channels/:channelId/sessions/:sessionId — rename a session */
sessions.patch("/:sessionId", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("channelId");
  const sessionId = c.req.param("sessionId");

  // Verify channel ownership
  const channel = await c.env.DB.prepare(
    "SELECT id FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first();

  if (!channel) return c.json({ error: "Channel not found" }, 404);

  const { name } = await c.req.json<{ name: string }>();

  if (!name?.trim()) {
    return c.json({ error: "Session name is required" }, 400);
  }

  await c.env.DB.prepare(
    "UPDATE sessions SET name = ?, updated_at = unixepoch() WHERE id = ? AND channel_id = ? AND user_id = ?",
  )
    .bind(name.trim(), sessionId, channelId, userId)
    .run();

  return c.json({ ok: true });
});

/** DELETE /api/channels/:channelId/sessions/:sessionId — delete a session */
sessions.delete("/:sessionId", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("channelId");
  const sessionId = c.req.param("sessionId");

  // Verify channel ownership
  const channel = await c.env.DB.prepare(
    "SELECT id FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first();

  if (!channel) return c.json({ error: "Channel not found" }, 404);

  // Don't allow deleting the last session
  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM sessions WHERE channel_id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first<{ cnt: number }>();

  if ((countRow?.cnt ?? 0) <= 1) {
    return c.json({ error: "Cannot delete the last session" }, 400);
  }

  // Get session_key before deleting (to clean up messages)
  const session = await c.env.DB.prepare(
    "SELECT session_key FROM sessions WHERE id = ? AND channel_id = ? AND user_id = ?",
  )
    .bind(sessionId, channelId, userId)
    .first<{ session_key: string }>();

  await c.env.DB.prepare(
    "DELETE FROM sessions WHERE id = ? AND channel_id = ? AND user_id = ?",
  )
    .bind(sessionId, channelId, userId)
    .run();

  // Clean up messages for this session
  if (session?.session_key) {
    await c.env.DB.prepare(
      "DELETE FROM messages WHERE session_key = ?",
    )
      .bind(session.session_key)
      .run();
  }

  return c.json({ ok: true });
});

export { sessions };
