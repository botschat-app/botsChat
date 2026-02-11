import { Hono } from "hono";
import type { Env } from "../env.js";
import { createToken, createRefreshToken, verifyRefreshToken, hashPassword, verifyPassword, getJwtSecret } from "../utils/auth.js";
import { verifyFirebaseIdToken } from "../utils/firebase.js";
import { generateId } from "../utils/id.js";

const auth = new Hono<{ Bindings: Env }>();

/** POST /api/auth/register — disabled in production (OAuth only) */
auth.post("/register", async (c) => {
  if (c.env.ENVIRONMENT !== "development") {
    return c.json({ error: "Email registration is disabled. Please sign in with Google or GitHub." }, 403);
  }

  const { email, password, displayName } = await c.req.json<{
    email: string;
    password: string;
    displayName?: string;
  }>();

  if (!email?.trim() || !password?.trim()) {
    return c.json({ error: "Email and password are required" }, 400);
  }

  // Basic email format validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return c.json({ error: "Invalid email format" }, 400);
  }

  // Password strength requirements
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters long" }, 400);
  }
  // Cap password length to prevent PBKDF2 resource exhaustion (DoS)
  if (password.length > 256) {
    return c.json({ error: "Password must not exceed 256 characters" }, 400);
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return c.json({ error: "Password must contain both letters and numbers" }, 400);
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
      // Generic error to prevent email enumeration
      return c.json({ error: "Registration failed. Please try a different email or sign in." }, 409);
    }
    throw err;
  }

  const secret = getJwtSecret(c.env);
  const token = await createToken(id, secret);
  const refreshToken = await createRefreshToken(id, secret);

  return c.json({ id, email, token, refreshToken }, 201);
});

/** POST /api/auth/login — disabled in production (OAuth only) */
auth.post("/login", async (c) => {
  if (c.env.ENVIRONMENT !== "development") {
    return c.json({ error: "Email login is disabled. Please sign in with Google or GitHub." }, 403);
  }

  const { email, password } = await c.req.json<{
    email: string;
    password: string;
  }>();

  if (!email?.trim() || !password?.trim()) {
    return c.json({ error: "Email and password are required" }, 400);
  }

  // Cap password length to prevent PBKDF2 resource exhaustion (DoS)
  if (password.length > 256) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  // Fetch user with password hash — we now verify in application code
  const row = await c.env.DB.prepare(
    "SELECT id, email, display_name, password_hash FROM users WHERE email = ?",
  )
    .bind(email.trim().toLowerCase())
    .first<{ id: string; email: string; display_name: string | null; password_hash: string }>();

  if (!row || !row.password_hash) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const { valid, needsRehash } = await verifyPassword(password, row.password_hash);
  if (!valid) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  // Transparently upgrade legacy SHA-256 hashes to PBKDF2
  if (needsRehash) {
    const newHash = await hashPassword(password);
    await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(newHash, row.id)
      .run();
  }

  const secret = getJwtSecret(c.env);
  const token = await createToken(row.id, secret);
  const refreshToken = await createRefreshToken(row.id, secret);

  return c.json({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    token,
    refreshToken,
  });
});

/**
 * POST /api/auth/firebase — sign in (or register) with a Firebase ID token.
 * Works for all Firebase-backed providers (Google, GitHub, etc.).
 */
async function handleFirebaseAuth(c: {
  req: { json: <T>() => Promise<T> };
  env: Env;
  json: (data: unknown, status?: number) => Response;
}) {
  const { idToken } = await c.req.json<{ idToken: string }>();

  if (!idToken?.trim()) {
    return c.json({ error: "idToken is required" }, 400);
  }

  const projectId = c.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    return c.json({ error: "Firebase sign-in is not configured" }, 500);
  }

  // 1. Verify the Firebase ID token
  let firebaseUser;
  try {
    firebaseUser = await verifyFirebaseIdToken(idToken, projectId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Token verification failed";
    return c.json({ error: msg }, 401);
  }

  const email = firebaseUser.email?.toLowerCase();
  if (!email) {
    return c.json({ error: "Account has no email address" }, 400);
  }

  const firebaseUid = firebaseUser.sub;
  // Determine provider from Firebase token (google.com, github.com, etc.)
  const signInProvider = firebaseUser.firebase?.sign_in_provider ?? "unknown";
  const authProvider = signInProvider.includes("google")
    ? "google"
    : signInProvider.includes("github")
      ? "github"
      : signInProvider;
  const displayName = firebaseUser.name ?? email.split("@")[0];

  // 2. Look up existing user by firebase_uid first, then by email
  let row = await c.env.DB.prepare(
    "SELECT id, email, display_name, auth_provider, password_hash FROM users WHERE firebase_uid = ?",
  )
    .bind(firebaseUid)
    .first<{ id: string; email: string; display_name: string | null; auth_provider: string; password_hash: string }>();

  if (!row) {
    // Check if there's an existing account with the same email
    const existing = await c.env.DB.prepare(
      "SELECT id, email, display_name, auth_provider, password_hash FROM users WHERE email = ?",
    )
      .bind(email)
      .first<{ id: string; email: string; display_name: string | null; auth_provider: string; password_hash: string }>();

    if (existing) {
      if (existing.password_hash) {
        // SECURITY: existing account has a password — do NOT auto-link.
        // The user must sign in with their password first, or the admin
        // must link accounts manually.  Auto-linking would let an
        // attacker who pre-registered the email access the real owner's
        // data once they sign in with OAuth.
        return c.json(
          {
            error: "An account with this email already exists. Please sign in with your email and password.",
            code: "EMAIL_EXISTS_WITH_PASSWORD",
          },
          409,
        );
      }
      // Existing account was created via OAuth (no password) — safe to link
      await c.env.DB.prepare(
        "UPDATE users SET firebase_uid = ?, auth_provider = ?, updated_at = unixepoch() WHERE id = ?",
      )
        .bind(firebaseUid, authProvider, existing.id)
        .run();
      row = existing;
    }
  }

  if (!row) {
    // 3. Create a new user (OAuth-only, no password)
    const id = generateId("u_");
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, auth_provider, firebase_uid)
       VALUES (?, ?, '', ?, ?, ?)`,
    )
      .bind(id, email, displayName, authProvider, firebaseUid)
      .run();

    row = { id, email, display_name: displayName, auth_provider: authProvider, password_hash: "" };
  }

  // 4. Issue our own JWT (access + refresh)
  const secret = getJwtSecret(c.env);
  const token = await createToken(row!.id, secret);
  const refreshToken = await createRefreshToken(row!.id, secret);

  return c.json({
    id: row!.id,
    email: row!.email,
    displayName: row!.display_name,
    token,
    refreshToken,
  });
}

// Register the unified Firebase auth handler and provider-specific aliases
auth.post("/firebase", (c) => handleFirebaseAuth(c));
auth.post("/google", (c) => handleFirebaseAuth(c));
auth.post("/github", (c) => handleFirebaseAuth(c));

/** POST /api/auth/refresh — exchange a refresh token for a new access token */
auth.post("/refresh", async (c) => {
  const { refreshToken } = await c.req.json<{ refreshToken: string }>();

  if (!refreshToken?.trim()) {
    return c.json({ error: "refreshToken is required" }, 400);
  }

  const secret = getJwtSecret(c.env);
  const payload = await verifyRefreshToken(refreshToken, secret);

  if (!payload) {
    return c.json({ error: "Invalid or expired refresh token" }, 401);
  }

  // Issue a new short-lived access token
  const token = await createToken(payload.sub, secret);

  return c.json({ token });
});

/** GET /api/auth/config — public endpoint returning allowed auth methods */
auth.get("/config", (c) => {
  const isDev = c.env.ENVIRONMENT === "development";
  return c.json({
    emailEnabled: isDev,
    googleEnabled: !!c.env.FIREBASE_PROJECT_ID,
    githubEnabled: !!c.env.FIREBASE_PROJECT_ID,
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

  const settings = JSON.parse(row.settings_json || "{}");
  delete settings.defaultModel; // not in D1 — comes from plugin (connection.status)

  return c.json({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    settings,
    createdAt: row.created_at,
  });
});

export { auth };
