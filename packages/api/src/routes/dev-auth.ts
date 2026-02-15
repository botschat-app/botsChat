import { Hono } from "hono";
import type { Env } from "../env.js";
import { createToken, getJwtSecret } from "../utils/auth.js";

const devAuth = new Hono<{ Bindings: Env }>();

/**
 * POST /api/dev-auth/login — secret-gated dev login for automated testing.
 * Returns 404 when DEV_AUTH_SECRET is not configured (endpoint invisible).
 */
devAuth.post("/login", async (c) => {
  const devSecret = c.env.DEV_AUTH_SECRET;
  if (!devSecret) {
    return c.json({ error: "Not found" }, 404);
  }

  const { secret } = await c.req.json<{ secret: string }>();
  if (!secret || secret !== devSecret) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const userId = "dev-test-user";
  const jwtSecret = getJwtSecret(c.env);
  const token = await createToken(userId, jwtSecret);

  return c.json({ token, userId });
});

export { devAuth };
