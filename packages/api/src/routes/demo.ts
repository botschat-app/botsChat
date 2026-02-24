import { Hono } from "hono";
import type { Env } from "../env.js";
import { createToken, createRefreshToken, getJwtSecret } from "../utils/auth.js";
import { generateId } from "../utils/id.js";
import { randomUUID } from "../utils/uuid.js";

const DEMO_USER_PREFIX = "demo_";
const DEMO_DISPLAY_NAME = "Demo User";
const DEMO_TTL_SECONDS = 24 * 3600; // 24 hours

function isDemoUserId(userId: string): boolean {
  return userId.startsWith(DEMO_USER_PREFIX);
}

const demo = new Hono<{ Bindings: Env }>();

/**
 * POST /api/demo/login — public endpoint for Google Play reviewers and demos.
 * Each call creates a fresh isolated demo user with seeded data.
 * Old demo users (>24h) are cleaned up in the background.
 * Rate limited: 1 request per 5 seconds per IP (via Cache API).
 */
demo.post("/login", async (c) => {
  // Rate limit by IP
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "unknown";
  const cache = caches.default;
  const rateCacheUrl = `https://rate.internal/demo-login/${ip}`;
  const rateCacheReq = new Request(rateCacheUrl);
  const cached = await cache.match(rateCacheReq);
  if (cached) {
    return c.json({ error: "Too many requests, try again later" }, 429);
  }
  c.executionCtx.waitUntil(
    cache.put(rateCacheReq, new Response(null, {
      headers: { "Cache-Control": "public, max-age=5" },
    })),
  );

  const jwtSecret = getJwtSecret(c.env);
  const userId = DEMO_USER_PREFIX + generateId("").slice(0, 12);
  const email = `${userId}@demo.botschat.app`;

  await c.env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, '', ?)",
  ).bind(userId, email, DEMO_DISPLAY_NAME).run();

  await seedDemoData(c.env.DB, userId);

  // Clean up expired demo users in the background (non-blocking)
  c.executionCtx.waitUntil(cleanupOldDemoUsers(c.env.DB));

  const token = await createToken(userId, jwtSecret);
  const refreshToken = await createRefreshToken(userId, jwtSecret);

  return c.json({
    id: userId,
    email,
    displayName: DEMO_DISPLAY_NAME,
    token,
    refreshToken,
  });
});

async function cleanupOldDemoUsers(db: D1Database) {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - DEMO_TTL_SECONDS;
    const { results } = await db.prepare(
      "SELECT id FROM users WHERE id LIKE 'demo_%' AND created_at < ? LIMIT 20",
    ).bind(cutoff).all<{ id: string }>();

    for (const row of results ?? []) {
      await db.batch([
        db.prepare("DELETE FROM messages WHERE user_id = ?").bind(row.id),
        db.prepare("DELETE FROM jobs WHERE user_id = ?").bind(row.id),
        db.prepare("DELETE FROM tasks WHERE channel_id IN (SELECT id FROM channels WHERE user_id = ?)").bind(row.id),
        db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.id),
        db.prepare("DELETE FROM channels WHERE user_id = ?").bind(row.id),
        db.prepare("DELETE FROM pairing_tokens WHERE user_id = ?").bind(row.id),
        db.prepare("DELETE FROM push_tokens WHERE user_id = ?").bind(row.id),
        db.prepare("DELETE FROM users WHERE id = ?").bind(row.id),
      ]);
    }
    if ((results?.length ?? 0) > 0) {
      console.log(`[demo] Cleaned up ${results!.length} expired demo users`);
    }
  } catch (err) {
    console.error("[demo] Cleanup failed:", err);
  }
}

async function seedDemoData(db: D1Database, userId: string) {
  const now = Math.floor(Date.now() / 1000);

  const ch1 = generateId("ch_");
  const ch2 = generateId("ch_");

  await db.batch([
    db.prepare(
      "INSERT INTO channels (id, user_id, name, description, openclaw_agent_id, system_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, 'main', '', ?, ?)",
    ).bind(ch1, userId, "General", "Default chat channel", now, now),
    db.prepare(
      "INSERT INTO channels (id, user_id, name, description, openclaw_agent_id, system_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, 'main', '', ?, ?)",
    ).bind(ch2, userId, "Tasks Demo", "Background task demo channel", now, now),
  ]);

  const adhocTask1 = generateId("tsk_");
  const adhocTask2 = generateId("tsk_");
  const ses1 = generateId("ses_");
  const ses2 = generateId("ses_");
  const sessionKey1 = `agent:main:botschat:${userId}:adhoc`;
  const sessionKey2 = `agent:main:botschat:${userId}:adhoc:${ch2}`;

  await db.batch([
    db.prepare(
      "INSERT INTO tasks (id, channel_id, name, kind, session_key, enabled, created_at, updated_at) VALUES (?, ?, 'Ad Hoc Chat', 'adhoc', ?, 1, ?, ?)",
    ).bind(adhocTask1, ch1, sessionKey1, now, now),
    db.prepare(
      "INSERT INTO tasks (id, channel_id, name, kind, session_key, enabled, created_at, updated_at) VALUES (?, ?, 'Ad Hoc Chat', 'adhoc', ?, 1, ?, ?)",
    ).bind(adhocTask2, ch2, sessionKey2, now, now),
    db.prepare(
      "INSERT INTO sessions (id, channel_id, user_id, name, session_key) VALUES (?, ?, ?, 'Session 1', ?)",
    ).bind(ses1, ch1, userId, sessionKey1),
    db.prepare(
      "INSERT INTO sessions (id, channel_id, user_id, name, session_key) VALUES (?, ?, ?, 'Session 1', ?)",
    ).bind(ses2, ch2, userId, sessionKey2),
  ]);

  const bgTask = generateId("tsk_");
  const bgCronId = randomUUID();
  const bgSessionKey = `agent:main:botschat:${userId}:task:${bgTask}`;

  await db.prepare(
    "INSERT INTO tasks (id, channel_id, name, kind, openclaw_cron_job_id, session_key, enabled, created_at, updated_at) VALUES (?, ?, ?, 'background', ?, ?, 1, ?, ?)",
  ).bind(bgTask, ch2, "Daily Summary", bgCronId, bgSessionKey, now, now).run();

  const jobId = `job_demo_${Date.now()}`;
  await db.prepare(
    "INSERT INTO jobs (id, task_id, user_id, session_key, status, started_at, finished_at, duration_ms, summary, created_at) VALUES (?, ?, ?, ?, 'ok', ?, ?, 2300, 'Daily summary generated successfully.', ?)",
  ).bind(jobId, bgTask, userId, bgSessionKey, now - 3600, now - 3600 + 2, now).run();

  const msgs = [
    { sender: "user", text: "Hello! What can you do?" },
    { sender: "agent", text: "Hi there! I'm your AI assistant powered by OpenClaw. I can help with:\n\n- **Chat**: Ask me anything — coding, writing, research, brainstorming\n- **Scheduled Tasks**: Set up recurring background jobs (e.g. daily summaries, monitoring)\n- **Multi-channel**: Organize conversations into separate channels\n- **E2E Encryption**: All messages can be end-to-end encrypted\n\nTry typing a message below!" },
    { sender: "user", text: "Can you summarize a webpage for me?" },
    { sender: "agent", text: "Absolutely! Just paste the URL and I'll summarize it for you. I can also extract key points, translate content, or answer questions about the page.\n\nFor example, you could say:\n> Summarize https://example.com/article\n\nNote: In this demo, I'll echo your messages back. Connect a real OpenClaw instance for full AI capabilities." },
  ];

  const msgBatch = msgs.map((m, i) =>
    db.prepare(
      "INSERT INTO messages (id, user_id, session_key, sender, text, encrypted, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).bind(randomUUID(), userId, sessionKey1, m.sender, m.text, now - 300 + i * 30),
  );
  await db.batch(msgBatch);
}

export { demo, isDemoUserId };
