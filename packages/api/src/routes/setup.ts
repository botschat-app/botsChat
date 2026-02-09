import { Hono } from "hono";
import type { Env } from "../env.js";
import { createToken, hashPassword } from "../utils/auth.js";
import { verifyFirebaseIdToken } from "../utils/firebase.js";
import { generateId, generatePairingToken } from "../utils/id.js";
import { resolveCloudUrlWithHints } from "../utils/resolve-url.js";

const setup = new Hono<{ Bindings: Env }>();

/**
 * POST /api/setup/init — One-shot CLI onboarding endpoint.
 *
 * Accepts email+password OR a Firebase idToken.
 * Returns everything the CLI needs to configure the OpenClaw plugin:
 *   - userId, JWT token, pairing token, cloud URL, ready-to-run commands.
 *
 * Idempotent: if the user already has a pairing token, a new one is created
 * for this setup session (old ones remain valid).
 */
setup.post("/init", async (c) => {
  const body = await c.req.json<{
    email?: string;
    password?: string;
    idToken?: string;
  }>();

  let userId: string;
  let email: string;
  let displayName: string | null = null;

  if (body.idToken) {
    // ---- Firebase auth path ----
    const projectId = c.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
      return c.json({ error: "Firebase sign-in is not configured" }, 500);
    }

    let firebaseUser;
    try {
      firebaseUser = await verifyFirebaseIdToken(body.idToken, projectId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Token verification failed";
      return c.json({ error: msg }, 401);
    }

    email = firebaseUser.email?.toLowerCase() ?? "";
    if (!email) return c.json({ error: "Account has no email" }, 400);

    displayName = firebaseUser.name ?? null;
    const firebaseUid = firebaseUser.sub;

    // Find or create user
    let row = await c.env.DB.prepare(
      "SELECT id, display_name, password_hash FROM users WHERE firebase_uid = ?",
    ).bind(firebaseUid).first<{ id: string; display_name: string | null; password_hash: string }>();

    if (!row) {
      const existing = await c.env.DB.prepare(
        "SELECT id, display_name, password_hash FROM users WHERE email = ?",
      ).bind(email).first<{ id: string; display_name: string | null; password_hash: string }>();

      if (existing) {
        if (existing.password_hash) {
          // SECURITY: refuse auto-link to password-protected account
          return c.json(
            {
              error: "An account with this email already exists. Use email+password instead.",
              code: "EMAIL_EXISTS_WITH_PASSWORD",
            },
            409,
          );
        }
        // OAuth-only account — safe to link
        await c.env.DB.prepare(
          "UPDATE users SET firebase_uid = ?, updated_at = unixepoch() WHERE id = ?",
        ).bind(firebaseUid, existing.id).run();
        row = existing;
      }
    }

    if (!row) {
      const id = generateId("u_");
      const signInProvider = firebaseUser.firebase?.sign_in_provider ?? "unknown";
      const authProvider = signInProvider.includes("google") ? "google"
        : signInProvider.includes("github") ? "github" : signInProvider;
      await c.env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, display_name, auth_provider, firebase_uid)
         VALUES (?, ?, '', ?, ?, ?)`,
      ).bind(id, email, displayName ?? email.split("@")[0], authProvider, firebaseUid).run();
      row = { id, display_name: displayName, password_hash: "" };
    }

    userId = row.id;
    displayName = row.display_name;
  } else {
    // ---- Email + password path ----
    if (!body.email?.trim() || !body.password?.trim()) {
      return c.json({ error: "email+password or idToken is required" }, 400);
    }

    email = body.email.trim().toLowerCase();
    const passwordHash = await hashPassword(body.password);

    const row = await c.env.DB.prepare(
      "SELECT id, display_name FROM users WHERE email = ? AND password_hash = ?",
    ).bind(email, passwordHash).first<{ id: string; display_name: string | null }>();

    if (!row) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    userId = row.id;
    displayName = row.display_name;
  }

  // ---- Create a fresh pairing token for this setup ----
  const ptId = generateId("pt_");
  const pairingToken = generatePairingToken();
  await c.env.DB.prepare(
    "INSERT INTO pairing_tokens (id, user_id, token, label) VALUES (?, ?, ?, ?)",
  ).bind(ptId, userId, pairingToken, "CLI setup").run();

  // ---- Ensure a default channel exists ----
  let channel = await c.env.DB.prepare(
    "SELECT id, name FROM channels WHERE user_id = ? LIMIT 1",
  ).bind(userId).first<{ id: string; name: string }>();

  if (!channel) {
    const chId = generateId("ch_");
    await c.env.DB.prepare(
      "INSERT INTO channels (id, user_id, name, description) VALUES (?, ?, ?, ?)",
    ).bind(chId, userId, "My Agent", "Default channel").run();
    channel = { id: chId, name: "My Agent" };
  }

  // ---- Issue JWT ----
  const secret = c.env.JWT_SECRET ?? "botschat-dev-secret";
  const token = await createToken(userId, secret);

  // ---- Resolve the best cloud URL for the plugin to connect back ----
  const { cloudUrl, isLoopback, hint } = resolveCloudUrlWithHints(c.req.raw, c.env);

  return c.json({
    userId,
    email,
    displayName,
    token,
    pairingToken,
    cloudUrl,
    ...(isLoopback ? { cloudUrlWarning: hint } : {}),
    channel: { id: channel.id, name: channel.name },
    setupCommands: [
      "openclaw plugins install @botschat/botschat",
      `openclaw config set channels.botschat.cloudUrl ${cloudUrl}`,
      `openclaw config set channels.botschat.pairingToken ${pairingToken}`,
      "openclaw config set channels.botschat.enabled true",
      "openclaw gateway restart",
    ],
  });
});

/**
 * GET /api/setup/cloud-url — Returns the recommended cloudUrl for the plugin.
 *
 * Used by the web onboarding page to display the correct URL in commands.
 * No auth required (the URL is not secret).
 */
setup.get("/cloud-url", async (c) => {
  const { cloudUrl, isLoopback, hint } = resolveCloudUrlWithHints(c.req.raw, c.env);
  return c.json({ cloudUrl, isLoopback, ...(hint ? { hint } : {}) });
});

/**
 * GET /api/setup/status — Check if the user's OpenClaw is connected.
 *
 * Used by CLI to verify the setup was successful.
 * Requires Bearer token auth.
 */
setup.get("/status", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const { verifyToken } = await import("../utils/auth.js");
  const jwtSecret = c.env.JWT_SECRET ?? "botschat-dev-secret";
  const payload = await verifyToken(authHeader.slice(7), jwtSecret);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const userId = payload.sub;

  // Query the DO for connection status
  const doId = c.env.CONNECTION_DO.idFromName(userId);
  const stub = c.env.CONNECTION_DO.get(doId);
  const resp = await stub.fetch(new Request("https://internal/status"));

  if (!resp.ok) {
    return c.json({ connected: false });
  }

  const status = await resp.json() as { openclawConnected?: boolean };

  return c.json({
    connected: !!status.openclawConnected,
    userId,
  });
});

export { setup };
