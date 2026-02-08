import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env.js";
import { authMiddleware } from "./utils/auth.js";
import { auth } from "./routes/auth.js";
import { agents } from "./routes/agents.js";
import { channels } from "./routes/channels.js";
import { tasks } from "./routes/tasks.js";
import { jobs } from "./routes/jobs.js";
import { models } from "./routes/models.js";
import { pairing } from "./routes/pairing.js";
import { sessions } from "./routes/sessions.js";
import { upload } from "./routes/upload.js";

// Re-export the Durable Object class so wrangler can find it
export { ConnectionDO } from "./do/connection-do.js";

const app = new Hono<{ Bindings: Env }>();

// Global CORS
app.use("/*", cors({ origin: "*", allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] }));

// Health check
app.get("/api/health", (c) => c.json({ status: "ok", version: "0.1.0" }));

// ---- Public routes (no auth) ----
app.route("/api/auth", auth);

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
  return c.json({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    settings: JSON.parse(row.settings_json || "{}"),
    createdAt: row.created_at,
  });
});

protectedApp.patch("/me", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ defaultModel?: string }>();

  const existing = await c.env.DB.prepare(
    "SELECT settings_json FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ settings_json: string }>();

  const settings = JSON.parse(existing?.settings_json || "{}");

  if (body.defaultModel !== undefined) {
    settings.defaultModel = body.defaultModel;
  }

  await c.env.DB.prepare(
    "UPDATE users SET settings_json = ? WHERE id = ?",
  )
    .bind(JSON.stringify(settings), userId)
    .run();

  return c.json({ ok: true, settings });
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

// ---- Media serving route (public, no auth) ----
app.get("/api/media/:userId/:filename", async (c) => {
  const userId = c.req.param("userId");
  const filename = c.req.param("filename");
  const key = `media/${userId}/${filename}`;

  const object = await c.env.MEDIA.get(key);
  if (!object) {
    return c.json({ error: "Not found" }, 404);
  }

  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(object.body, { headers });
});

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

    // Look up user by pairing token
    const row = await c.env.DB.prepare(
      "SELECT user_id FROM pairing_tokens WHERE token = ?",
    )
      .bind(token)
      .first<{ user_id: string }>();

    if (!row) {
      return c.json({ error: "Invalid pairing token" }, 401);
    }
    userId = row.user_id;

    // Update last_connected_at
    await c.env.DB.prepare(
      "UPDATE pairing_tokens SET last_connected_at = unixepoch() WHERE token = ?",
    )
      .bind(token)
      .run();
  }

  const doId = c.env.CONNECTION_DO.idFromName(userId);
  const stub = c.env.CONNECTION_DO.get(doId);
  const url = new URL(c.req.url);
  url.pathname = `/gateway/${userId}`;
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// Browser client connects to: /api/ws/:userId/:sessionId
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
  const doId = c.env.CONNECTION_DO.idFromName(userId);
  const stub = c.env.CONNECTION_DO.get(doId);
  const url = new URL(c.req.url);
  url.pathname = "/status";
  return stub.fetch(new Request(url.toString()));
});

// Message history: /api/messages/:userId?sessionKey=xxx
app.get("/api/messages/:userId", async (c) => {
  const userId = c.req.param("userId");
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
