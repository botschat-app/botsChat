import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env.js";
import { authMiddleware, verifyToken, getJwtSecret, verifyMediaSignature } from "./utils/auth.js";
import { auth } from "./routes/auth.js";
import { agents } from "./routes/agents.js";
import { channels } from "./routes/channels.js";
import { tasks } from "./routes/tasks.js";
import { jobs } from "./routes/jobs.js";
import { models } from "./routes/models.js";
import { pairing } from "./routes/pairing.js";
import { sessions } from "./routes/sessions.js";
import { upload } from "./routes/upload.js";
import { setup } from "./routes/setup.js";

// Re-export the Durable Object class so wrangler can find it
export { ConnectionDO } from "./do/connection-do.js";

const app = new Hono<{ Bindings: Env }>();

// Production CORS origins
const PRODUCTION_ORIGINS = [
  "https://console.botschat.app",
  "https://botschat.app",
  "https://botschat-api.auxtenwpc.workers.dev",
  "capacitor://localhost",  // iOS Capacitor app
  "http://localhost",       // Android Capacitor app
];

// CORS and security headers — skip for WebSocket upgrade requests
// (101 responses have immutable headers in Cloudflare Workers)
const corsMiddleware = cors({
  origin: (origin, c) => {
    if (PRODUCTION_ORIGINS.includes(origin)) return origin;
    // Only allow localhost/private IPs in development
    if ((c as unknown as { env: Env }).env?.ENVIRONMENT === "development") {
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
      if (/^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(origin)) return origin;
    }
    return ""; // disallow
  },
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
});

app.use("/*", async (c, next) => {
  // WebSocket upgrades return 101 with immutable headers — skip CORS & security headers
  if (c.req.header("Upgrade")?.toLowerCase() === "websocket") {
    await next();
    return;
  }

  // Apply CORS for regular HTTP requests
  return corsMiddleware(c, next);
});

// Security response headers.
// In Cloudflare Workers, responses from Durable Objects (stub.fetch()) and
// subrequests have immutable headers. We clone the response first, then set
// security headers on the mutable clone. This also makes headers mutable for
// the CORS middleware which runs AFTER this (registered earlier → runs later
// in the response phase).
app.use("/*", async (c, next) => {
  await next();
  if (c.res.status === 101) return; // WebSocket 101 — can't clone
  // Clone to ensure mutable headers
  c.res = new Response(c.res.body, c.res);
  c.res.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://apis.google.com https://*.firebaseapp.com; style-src 'self' 'unsafe-inline'; img-src 'self' https://*.r2.dev https://*.cloudflarestorage.com data: blob:; connect-src 'self' wss://*.botschat.app wss://console.botschat.app https://apis.google.com https://*.googleapis.com; frame-src https://accounts.google.com https://*.firebaseapp.com",
  );
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
});

// Health check
app.get("/api/health", (c) => c.json({ status: "ok", version: "0.1.0" }));

// Rate limiting is handled by Cloudflare WAF Rate Limiting Rules (Dashboard).
// See the security audit for recommended rule configuration.
// No in-memory rate limiter — it cannot survive Worker isolate restarts
// and is not shared across instances.

// ---- Public routes (no auth) ----
app.route("/api/auth", auth);
app.route("/api/setup", setup);

// ---- Protected routes (require Bearer token) ----
const protectedApp = new Hono<{ Bindings: Env; Variables: { userId: string } }>();
protectedApp.use("/*", authMiddleware());
protectedApp.route("/agents", agents);
protectedApp.route("/channels", channels);
protectedApp.route("/models", models);
protectedApp.get("/me", async (c) => {
  // Proxy /api/me to the auth /me handler
  const userId = c.get("userId");
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
  // defaultModel is not stored in D1 — it comes from the plugin (connection.status).
  delete settings.defaultModel;
  return c.json({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    settings,
    createdAt: row.created_at,
  });
});

protectedApp.patch("/me", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ defaultModel?: string }>();

  // defaultModel is not stored in D1 — get/set only via plugin (connection.status / push).
  const existing = await c.env.DB.prepare(
    "SELECT settings_json FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ settings_json: string }>();

  const settings = JSON.parse(existing?.settings_json || "{}");
  delete settings.defaultModel;
  // Persist other settings (if any) to D1; defaultModel is never written.
  await c.env.DB.prepare(
    "UPDATE users SET settings_json = ? WHERE id = ?",
  )
    .bind(JSON.stringify(settings), userId)
    .run();

  if (body.defaultModel !== undefined) {
    try {
      const doId = c.env.CONNECTION_DO.idFromName(userId);
      const stub = c.env.CONNECTION_DO.get(doId);
      await stub.fetch(
        new Request("https://internal/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "settings.defaultModel",
            defaultModel: body.defaultModel ?? "",
          }),
        }),
      );
    } catch (err) {
      console.error("Failed to push default model to OpenClaw:", err);
    }
  }

  const outSettings = { ...settings };
  delete outSettings.defaultModel;
  return c.json({ ok: true, settings: outSettings });
});

// OpenClaw scan data — schedule/instructions/model cached in the ConnectionDO.
// These fields belong to OpenClaw (not stored in D1) and are refreshed whenever
// the plugin sends a task.scan.result message.
protectedApp.get("/task-scan", async (c) => {
  const userId = c.get("userId");
  const doId = c.env.CONNECTION_DO.idFromName(userId);
  const stub = c.env.CONNECTION_DO.get(doId);
  const resp = await stub.fetch(new Request("https://internal/scan-data"));
  return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json" } });
});

// Top-level task listing (for Automations view)
// Note: schedule, instructions, model are NOT stored in D1.
// They belong to OpenClaw and are retrieved via GET /api/task-scan.
protectedApp.get("/tasks", async (c) => {
  const userId = c.get("userId");
  const kind = c.req.query("kind") ?? "background";

  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.channel_id, t.name, t.kind, t.openclaw_cron_job_id,
            t.session_key, t.enabled, t.created_at, t.updated_at
     FROM tasks t
     JOIN channels ch ON t.channel_id = ch.id
     WHERE ch.user_id = ? AND t.kind = ?
     ORDER BY t.created_at ASC`,
  )
    .bind(userId, kind)
    .all<{
      id: string;
      channel_id: string;
      name: string;
      kind: string;
      openclaw_cron_job_id: string | null;
      session_key: string | null;
      enabled: number;
      created_at: number;
      updated_at: number;
    }>();

  return c.json({
    tasks: (results ?? []).map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      name: r.name,
      kind: r.kind,
      openclawCronJobId: r.openclaw_cron_job_id,
      sessionKey: r.session_key,
      enabled: !!r.enabled,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

// Top-level job listing for a task (for Automations view)
protectedApp.get("/tasks/:taskId/jobs", async (c) => {
  const userId = c.get("userId");
  const taskId = c.req.param("taskId");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

  // Verify the task belongs to this user
  const task = await c.env.DB.prepare(
    `SELECT t.id, t.kind FROM tasks t
     JOIN channels ch ON t.channel_id = ch.id
     WHERE t.id = ? AND ch.user_id = ?`,
  )
    .bind(taskId, userId)
    .first<{ id: string; kind: string }>();

  if (!task) return c.json({ error: "Task not found" }, 404);
  if (task.kind !== "background") return c.json({ error: "Only background tasks have jobs" }, 400);

  const { results } = await c.env.DB.prepare(
    `SELECT id, session_key, status, started_at, finished_at, duration_ms, summary, created_at
     FROM jobs WHERE task_id = ? AND user_id = ?
     ORDER BY started_at DESC LIMIT ?`,
  )
    .bind(taskId, userId, limit)
    .all<{
      id: string;
      session_key: string;
      status: string;
      started_at: number;
      finished_at: number | null;
      duration_ms: number | null;
      summary: string;
      created_at: number;
    }>();

  return c.json({
    jobs: (results ?? []).map((r, idx, arr) => ({
      id: r.id,
      number: arr.length - idx,
      sessionKey: r.session_key,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms,
      summary: r.summary,
      time: new Date(r.started_at * 1000).toLocaleString(),
    })),
  });
});

// Nested task routes under /api/channels/:channelId/tasks
protectedApp.route("/channels/:channelId/tasks", tasks);
// Nested job routes under /api/channels/:channelId/tasks/:taskId/jobs
protectedApp.route("/channels/:channelId/tasks/:taskId/jobs", jobs);
// Nested session routes under /api/channels/:channelId/sessions
protectedApp.route("/channels/:channelId/sessions", sessions);
protectedApp.route("/pairing-tokens", pairing);
protectedApp.route("/upload", upload);

// ---- Media serving route (signed URL or Bearer auth) ----
app.get("/api/media/:userId/:filename", async (c) => {
  const userId = c.req.param("userId");
  const filename = c.req.param("filename");

  // Verify access: either a valid signed URL or a valid Bearer token
  const expires = c.req.query("expires");
  const sig = c.req.query("sig");
  const secret = getJwtSecret(c.env);

  if (expires && sig) {
    // Signed URL verification
    const valid = await verifyMediaSignature(userId, filename, expires, sig, secret);
    if (!valid) {
      return c.json({ error: "Invalid or expired media signature" }, 403);
    }
  } else {
    // Fall back to Bearer token auth
    const denied = await verifyUserAccess(c, userId);
    if (denied) return denied;
  }

  const key = `media/${userId}/${filename}`;
  const object = await c.env.MEDIA.get(key);
  if (!object) {
    return c.json({ error: "Not found" }, 404);
  }

  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=3600"); // 1h cache (matches signature expiry)

  return new Response(object.body, { headers });
});

// ---- Helper: verify JWT and ensure userId matches ----
async function verifyUserAccess(c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined }; env: Env; json: (data: unknown, status?: number) => Response }, userId: string): Promise<Response | null> {
  const authHeader = c.req.header("Authorization");
  const tokenStr = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : c.req.query("token");
  if (!tokenStr) {
    return c.json({ error: "Missing Authorization header or token query param" }, 401);
  }
  const secret = getJwtSecret(c.env);
  const payload = await verifyToken(tokenStr, secret);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
  if (payload.sub !== userId) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return null; // access granted
}

// ---- WebSocket upgrade routes (BEFORE protected middleware) ----

// OpenClaw plugin connects to: /api/gateway/:connId
// connId can be a userId or "default" — in the latter case, we look up
// the user via the pairing token passed in the Sec-WebSocket-Protocol header
// or the ?token= query parameter.
app.all("/api/gateway/:connId", async (c) => {
  let userId = c.req.param("connId");

  // If connId is not a real user ID (e.g. "default"), resolve via token
  if (!userId.startsWith("u_")) {
    const token =
      c.req.query("token") ??
      c.req.header("X-Pairing-Token") ??
      null;

    if (!token) {
      return c.json({ error: "Token required for gateway connection" }, 401);
    }

    // Look up user by pairing token (exclude revoked tokens)
    const row = await c.env.DB.prepare(
      "SELECT user_id FROM pairing_tokens WHERE token = ? AND revoked_at IS NULL",
    )
      .bind(token)
      .first<{ user_id: string }>();

    if (!row) {
      return c.json({ error: "Invalid pairing token" }, 401);
    }
    userId = row.user_id;

    // Update audit fields: last_connected_at, last_ip, connection_count
    const clientIp = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "unknown";
    await c.env.DB.prepare(
      `UPDATE pairing_tokens
       SET last_connected_at = unixepoch(), last_ip = ?, connection_count = connection_count + 1
       WHERE token = ?`,
    )
      .bind(clientIp, token)
      .run();
  }

  const doId = c.env.CONNECTION_DO.idFromName(userId);
  const stub = c.env.CONNECTION_DO.get(doId);
  const url = new URL(c.req.url);
  // Pass verified userId to DO — the API worker already validated the token
  // against D1 above, so DO can trust this.
  url.pathname = `/gateway/${userId}`;
  url.searchParams.set("verified", "1");
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// Browser client connects to: /api/ws/:userId/:sessionId
// Auth is handled entirely inside the DO via the "auth" message after
// the WebSocket connection is established. This avoids putting the JWT
// in the URL query string (which would leak it in logs/browser history).
app.all("/api/ws/:userId/:sessionId", async (c) => {
  const userId = c.req.param("userId");
  const sessionId = c.req.param("sessionId");
  const doId = c.env.CONNECTION_DO.idFromName(userId);
  const stub = c.env.CONNECTION_DO.get(doId);
  const url = new URL(c.req.url);
  url.pathname = `/client/${sessionId}`;
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// Connection status: /api/connection/:userId/status
app.get("/api/connection/:userId/status", async (c) => {
  const userId = c.req.param("userId");
  const denied = await verifyUserAccess(c, userId);
  if (denied) return denied;
  const doId = c.env.CONNECTION_DO.idFromName(userId);
  const stub = c.env.CONNECTION_DO.get(doId);
  const url = new URL(c.req.url);
  url.pathname = "/status";
  return stub.fetch(new Request(url.toString()));
});

// Message history: /api/messages/:userId?sessionKey=xxx
app.get("/api/messages/:userId", async (c) => {
  const userId = c.req.param("userId");
  const denied = await verifyUserAccess(c, userId);
  if (denied) return denied;
  const doId = c.env.CONNECTION_DO.idFromName(userId);
  const stub = c.env.CONNECTION_DO.get(doId);
  const url = new URL(c.req.url);
  url.pathname = "/messages";
  // Forward query params (sessionKey, threadId, limit)
  return stub.fetch(new Request(url.toString()));
});

// ---- Protected routes (require Bearer token) — AFTER ws routes ----
app.route("/api", protectedApp);

export default app;
