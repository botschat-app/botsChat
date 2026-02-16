import { Hono } from "hono";
import type { Env } from "../env.js";
import { createToken, getJwtSecret } from "../utils/auth.js";
import { generateId } from "../utils/id.js";

const devAuth = new Hono<{ Bindings: Env }>();

/**
 * POST /api/dev-auth/login — secret-gated dev login for automated testing.
 * Returns 404 when DEV_AUTH_SECRET is not configured (endpoint invisible).
 * Auto-creates the user record in D1 if it doesn't exist (upsert).
 */
devAuth.post("/login", async (c) => {
  const devSecret = c.env.DEV_AUTH_SECRET;
  if (!devSecret || c.env.ENVIRONMENT !== "development") {
    return c.json({ error: "Not found" }, 404);
  }

  const { secret, userId: requestedUserId } = await c.req.json<{ secret: string; userId?: string }>();
  if (!secret || secret !== devSecret) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const userId = requestedUserId || "dev-test-user";
  const jwtSecret = getJwtSecret(c.env);
  const token = await createToken(userId, jwtSecret);

  // Ensure the user exists in D1 (upsert) so foreign key constraints are satisfied.
  // Dev-auth users get a placeholder email and no password (login only via dev-auth).
  try {
    const existing = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
    if (!existing) {
      const email = `${userId}@dev.botschat.test`;
      await c.env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, '', ?)",
      ).bind(userId, email, userId).run();
    }
  } catch (err) {
    console.error("[dev-auth] Failed to upsert user:", err);
  }

  return c.json({ token, userId });
});

export { devAuth };
