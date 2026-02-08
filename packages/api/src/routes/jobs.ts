import { Hono } from "hono";
import type { Env } from "../env.js";

/**
 * Jobs API — background task execution history.
 * Mounted at /api/channels/:channelId/tasks/:taskId/jobs
 */
const jobs = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

/** GET / — list jobs for a background task */
jobs.get("/", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("channelId");
  const taskId = c.req.param("taskId");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

  // Verify ownership chain
  const channel = await c.env.DB.prepare(
    "SELECT id FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first();
  if (!channel) return c.json({ error: "Channel not found" }, 404);

  const task = await c.env.DB.prepare(
    "SELECT id, kind FROM tasks WHERE id = ? AND channel_id = ?",
  )
    .bind(taskId, channelId)
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

export { jobs };
