import { Hono } from "hono";
import type { Env } from "../env.js";
import { createToken, hashPassword } from "../utils/auth.js";
import { generateId } from "../utils/id.js";

const auth = new Hono<{ Bindings: Env }>();

/** POST /api/auth/register */
auth.post("/register", async (c) => {
  const { email, password, displayName } = await c.req.json<{
    email: string;
    password: string;
    displayName?: string;
  }>();

  if (!email?.trim() || !password?.trim()) {
    return c.json({ error: "Email and password are required" }, 400);
  }

  const id = generateId("u_");
  const passwordHash = await hashPassword(password);

  try {
    await c.env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)",
    )
      .bind(id, email.trim().toLowerCase(), passwordHash, displayName?.trim() ?? null)
      .run();
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      return c.json({ error: "Email already registered" }, 409);
    }
    throw err;
  }

  const secret = c.env.JWT_SECRET ?? "botschat-dev-secret";
  const token = await createToken(id, secret);

  return c.json({ id, email, token }, 201);
});

/** POST /api/auth/login */
auth.post("/login", async (c) => {
  const { email, password } = await c.req.json<{
    email: string;
    password: string;
  }>();

  if (!email?.trim() || !password?.trim()) {
    return c.json({ error: "Email and password are required" }, 400);
  }

  const passwordHash = await hashPassword(password);

  const row = await c.env.DB.prepare(
    "SELECT id, email, display_name FROM users WHERE email = ? AND password_hash = ?",
  )
    .bind(email.trim().toLowerCase(), passwordHash)
    .first<{ id: string; email: string; display_name: string | null }>();

  if (!row) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const secret = c.env.JWT_SECRET ?? "botschat-dev-secret";
  const token = await createToken(row.id, secret);

  return c.json({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    token,
  });
});

/** GET /api/auth/me — returns current user info */
auth.get("/me", async (c) => {
  // This route requires auth middleware to be applied upstream
  const userId = c.get("userId" as never) as string;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const row = await c.env.DB.prepare(
    "SELECT id, email, display_name, settings_json, created_at FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      settings_json: string;
      created_at: number;
    }>();

  if (!row) return c.json({ error: "User not found" }, 404);

  return c.json({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    settings: JSON.parse(row.settings_json || "{}"),
    createdAt: row.created_at,
  });
});

export { auth };
