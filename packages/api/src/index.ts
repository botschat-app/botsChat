import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env.js";
import { authMiddleware, verifyToken, getJwtSecret, verifyMediaSignature, signMediaUrl } from "./utils/auth.js";
import { randomUUID } from "./utils/uuid.js";
import { auth } from "./routes/auth.js";
import { agents } from "./routes/agents.js";
import { agentsV2 } from "./routes/agents-v2.js";
import { channels } from "./routes/channels.js";
import { tasks } from "./routes/tasks.js";
import { jobs } from "./routes/jobs.js";
import { models } from "./routes/models.js";
import { pairing } from "./routes/pairing.js";
import { sessions } from "./routes/sessions.js";
import { upload } from "./routes/upload.js";
import { push } from "./routes/push.js";
import { setup } from "./routes/setup.js";
import { devAuth } from "./routes/dev-auth.js";

// Re-export the Durable Object class so wrangler can find it
export { ConnectionDO } from "./do/connection-do.js";

const app = new Hono<{ Bindings: Env }>();

// Production CORS origins
const PRODUCTION_ORIGINS = [
  "https://console.botschat.app",
  "https://botschat.app",
  "https://botschat-api.auxtenwpc.workers.dev",
  "capacitor://localhost",  // iOS Capacitor app
  "http://localhost",       // Android Capacitor app (http scheme)
  "https://localhost",      // Android Capacitor app (https scheme)
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
app.route("/api/dev-auth", devAuth);
app.route("/api/setup", setup);

// ---- Protected routes (require Bearer token) ----
const protectedApp = new Hono<{ Bindings: Env; Variables: { userId: string } }>();
protectedApp.use("/*", authMiddleware());
protectedApp.route("/agents", agents);
protectedApp.route("/v2/agents", agentsV2);
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
  const body = await c.req.json<{ defaultModel?: string; notifyPreview?: boolean }>();

  // defaultModel is not stored in D1 — get/set only via plugin (connection.status / push).
  const existing = await c.env.DB.prepare(
    "SELECT settings_json FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ settings_json: string }>();

  const settings = JSON.parse(existing?.settings_json || "{}");
  delete settings.defaultModel;

  if (body.notifyPreview !== undefined) {
    settings.notifyPreview = body.notifyPreview;
  }

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

  if (body.notifyPreview !== undefined) {
    try {
      const doId = c.env.CONNECTION_DO.idFromName(userId);
      const stub = c.env.CONNECTION_DO.get(doId);
      await stub.fetch(
        new Request("https://internal/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "settings.notifyPreview",
            enabled: body.notifyPreview,
          }),
        }),
      );
    } catch (err) {
      console.error("Failed to push notifyPreview to OpenClaw:", err);
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
protectedApp.route("/push-tokens", push);
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

  let agentId: string | null = null;

  if (!userId.startsWith("u_")) {
    const token =
      c.req.query("token") ??
      c.req.header("X-Pairing-Token") ??
      null;

    if (!token) {
      return c.json({ error: "Token required for gateway connection" }, 401);
    }

    // v2: try agents table first (multi-agent), fallback to pairing_tokens (legacy)
    const agentRow = await c.env.DB.prepare(
      "SELECT id, user_id FROM agents WHERE pairing_token = ?",
    )
      .bind(token)
      .first<{ id: string; user_id: string }>();

    if (agentRow) {
      userId = agentRow.user_id;
      agentId = agentRow.id;
    } else {
      const row = await c.env.DB.prepare(
        "SELECT user_id FROM pairing_tokens WHERE token = ? AND revoked_at IS NULL",
      )
        .bind(token)
        .first<{ user_id: string }>();

      if (!row) {
        return c.json({ error: "Invalid pairing token" }, 401);
      }
      userId = row.user_id;
    }
  }

  // --- Worker-level rate limit (Cache API) ---
  // Protects the DO from being woken up during reconnection storms.
  // The Cache API persists across Worker isolates within the same colo.
  const GATEWAY_COOLDOWN_S = 10;
  const cache = caches.default;
  const rateCacheUrl = `https://rate.internal/gateway/${userId}`;
  const rateCacheReq = new Request(rateCacheUrl);
  const rateCached = await cache.match(rateCacheReq);
  if (rateCached) {
    return c.text("Too many connections, retry later", 429, {
      "Retry-After": String(GATEWAY_COOLDOWN_S),
    });
  }

  // Audit: update connection stats (agents table for v2, pairing_tokens for legacy)
  const token = c.req.query("token") ?? c.req.header("X-Pairing-Token");
  if (token) {
    const clientIp = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "unknown";
    if (agentId) {
      c.executionCtx.waitUntil(
        c.env.DB.prepare(
          `UPDATE agents
           SET status = 'connected', last_connected_at = unixepoch(), last_ip = ?, connection_count = connection_count + 1, updated_at = unixepoch()
           WHERE id = ?`,
        ).bind(clientIp, agentId).run(),
      );
    } else {
      c.executionCtx.waitUntil(
        c.env.DB.prepare(
          `UPDATE pairing_tokens
           SET last_connected_at = unixepoch(), last_ip = ?, connection_count = connection_count + 1
           WHERE token = ?`,
        ).bind(clientIp, token).run(),
      );
    }
  }

  const doId = c.env.CONNECTION_DO.idFromName(userId);
  const stub = c.env.CONNECTION_DO.get(doId);
  const url = new URL(c.req.url);
  url.pathname = `/gateway/${userId}`;
  url.searchParams.set("verified", "1");
  if (agentId) url.searchParams.set("agentId", agentId);
  const doResp = await stub.fetch(new Request(url.toString(), c.req.raw));

  // Cache the rate limit after the DO responds (success or rate-limited).
  // 101 = WebSocket accepted; 429 = DO's own rate limit.
  // Either way, prevent further DO wake-ups for GATEWAY_COOLDOWN_S.
  if (doResp.status === 101 || doResp.status === 429) {
    c.executionCtx.waitUntil(
      cache.put(
        rateCacheReq,
        new Response(null, {
          headers: { "Cache-Control": `public, max-age=${GATEWAY_COOLDOWN_S}` },
        }),
      ),
    );
  }

  return doResp;
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

// ---- Plugin upload (pairing token auth) ----
app.post("/api/plugin-upload", async (c) => {
  const token = c.req.header("X-Pairing-Token");
  if (!token) {
    return c.json({ error: "Missing X-Pairing-Token header" }, 401);
  }

  // v2: try agents table first, fallback to pairing_tokens
  const agentRow = await c.env.DB.prepare(
    "SELECT user_id FROM agents WHERE pairing_token = ?",
  )
    .bind(token)
    .first<{ user_id: string }>();

  let userId: string;
  if (agentRow) {
    userId = agentRow.user_id;
  } else {
    const row = await c.env.DB.prepare(
      "SELECT user_id FROM pairing_tokens WHERE token = ? AND revoked_at IS NULL",
    )
      .bind(token)
      .first<{ user_id: string }>();
    if (!row) {
      return c.json({ error: "Invalid pairing token" }, 401);
    }
    userId = row.user_id;
  }
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "Expected multipart/form-data" }, 400);
  }

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return c.json({ error: "No file provided" }, 400);
  }

  const MAX_SIZE = 20 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    return c.json({ error: "File too large (max 20 MB)" }, 413);
  }

  const fileType = file.type || "application/octet-stream";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";
  const safeExt = /^[a-z0-9]{1,5}$/.test(ext) ? ext : "bin";
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${safeExt}`;
  const key = `media/${userId}/${filename}`;

  await c.env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: fileType },
  });

  const secret = getJwtSecret(c.env);
  const url = await signMediaUrl(userId, filename, secret, 3600);
  return c.json({ url, key });
});

// ---- Protected routes (require Bearer token) — AFTER ws routes ----
app.route("/api", protectedApp);

export default app;
