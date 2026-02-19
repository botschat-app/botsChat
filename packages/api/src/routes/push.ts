import { Hono } from "hono";
import type { Env } from "../env.js";
import { generateId } from "../utils/id.js";

const push = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

/** POST /api/push-tokens — register or update a device push token */
push.post("/", async (c) => {
  const userId = c.get("userId");
  const { token, platform } = await c.req.json<{ token: string; platform: string }>();

  if (!token || !platform) {
    return c.json({ error: "Missing token or platform" }, 400);
  }
  if (!["web", "ios", "android"].includes(platform)) {
    return c.json({ error: "Invalid platform (web | ios | android)" }, 400);
  }

  const id = generateId("pt_");
  const now = Math.floor(Date.now() / 1000);

  // Upsert: if the same user+token already exists, update the timestamp
  await c.env.DB.prepare(
    `INSERT INTO push_tokens (id, user_id, token, platform, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, token) DO UPDATE SET platform = excluded.platform, updated_at = excluded.updated_at`,
  )
    .bind(id, userId, token, platform, now, now)
    .run();

  return c.json({ ok: true, id }, 201);
});

/** DELETE /api/push-tokens — unregister a device push token */
push.delete("/", async (c) => {
  const userId = c.get("userId");
  const { token } = await c.req.json<{ token: string }>().catch(() => ({ token: "" }));

  if (!token) {
    return c.json({ error: "Missing token" }, 400);
  }

  await c.env.DB.prepare(
    "DELETE FROM push_tokens WHERE user_id = ? AND token = ?",
  )
    .bind(userId, token)
    .run();

  return c.json({ ok: true });
});

export { push };
