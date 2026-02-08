import { Hono } from "hono";
import type { Env } from "../env.js";
import { generateId } from "../utils/id.js";

const tasks = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

// ---------------------------------------------------------------------------
// Helper: push task schedule to OpenClaw via ConnectionDO
// ---------------------------------------------------------------------------
async function pushScheduleToOpenClaw(
  env: Env,
  userId: string,
  task: { taskId: string; name?: string; openclawCronJobId: string; agentId: string; schedule: string; instructions: string; enabled: boolean; model?: string },
): Promise<void> {
  try {
    const doId = env.CONNECTION_DO.idFromName(userId);
    const stub = env.CONNECTION_DO.get(doId);
    await stub.fetch(
      new Request("https://internal/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "task.schedule",
          taskId: task.taskId,
          name: task.name,
          cronJobId: task.openclawCronJobId,
          agentId: task.agentId,
          schedule: task.schedule,
          instructions: task.instructions,
          enabled: task.enabled,
          model: task.model,
        }),
      }),
    );
  } catch (err) {
    console.error("Failed to push schedule to OpenClaw:", err);
  }
}

// ---------------------------------------------------------------------------
// Helper: push task delete to OpenClaw via ConnectionDO
// ---------------------------------------------------------------------------
async function pushDeleteToOpenClaw(
  env: Env,
  userId: string,
  cronJobId: string,
): Promise<void> {
  try {
    const doId = env.CONNECTION_DO.idFromName(userId);
    const stub = env.CONNECTION_DO.get(doId);
    await stub.fetch(
      new Request("https://internal/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "task.delete",
          cronJobId,
        }),
      }),
    );
  } catch (err) {
    console.error("Failed to push task delete to OpenClaw:", err);
  }
}

/** GET /api/channels/:channelId/tasks — list tasks for a channel */
tasks.get("/", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("channelId");

  // Verify channel ownership
  const channel = await c.env.DB.prepare(
    "SELECT id, openclaw_agent_id FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first<{ id: string; openclaw_agent_id: string }>();

  if (!channel) return c.json({ error: "Channel not found" }, 404);

  // Note: schedule, instructions, model are NOT stored in D1.
  // They belong to OpenClaw and are delivered to the frontend via WebSocket task.scan.result.
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, kind, openclaw_cron_job_id, session_key, enabled, created_at, updated_at FROM tasks WHERE channel_id = ? ORDER BY kind ASC, created_at ASC",
  )
    .bind(channelId)
    .all<{
      id: string;
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

/** POST /api/channels/:channelId/tasks — create a new task */
tasks.post("/", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("channelId");

  // Verify channel ownership
  const channel = await c.env.DB.prepare(
    "SELECT id, openclaw_agent_id FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first<{ id: string; openclaw_agent_id: string }>();

  if (!channel) return c.json({ error: "Channel not found" }, 404);

  const { name, kind, schedule, instructions } = await c.req.json<{
    name: string;
    kind: "background" | "adhoc";
    schedule?: string;
    instructions?: string;
  }>();

  if (!name?.trim()) {
    return c.json({ error: "Task name is required" }, 400);
  }
  if (!["background", "adhoc"].includes(kind)) {
    return c.json({ error: "Task kind must be 'background' or 'adhoc'" }, 400);
  }

  const id = generateId("tsk_");
  const agentId = channel.openclaw_agent_id;

  // Build session key based on task kind
  let sessionKey: string;
  if (kind === "adhoc") {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    sessionKey = `agent:${agentId}:botschat:${userId}:adhoc:${slug}`;
  } else {
    sessionKey = `agent:${agentId}:botschat:${userId}:task:${id}`;
  }

  // D1 only stores basic task metadata — schedule/instructions/model belong to OpenClaw.
  // openclawCronJobId is initially null for new background tasks; it will be set
  // when the plugin creates the cron job and sends back a task.schedule.ack.
  await c.env.DB.prepare(
    "INSERT INTO tasks (id, channel_id, name, kind, openclaw_cron_job_id, session_key) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, channelId, name.trim(), kind, null, sessionKey)
    .run();

  // Push schedule to OpenClaw for background tasks (plugin will create the cron job)
  if (kind === "background" && schedule) {
    await pushScheduleToOpenClaw(c.env, userId, {
      taskId: id,
      name: name.trim(),
      openclawCronJobId: "",
      agentId,
      schedule: schedule.trim(),
      instructions: instructions?.trim() ?? "",
      enabled: true,
    });
  }

  return c.json(
    {
      id,
      name: name.trim(),
      kind,
      openclawCronJobId: null,
      sessionKey,
      enabled: true,
    },
    201,
  );
});

/** PATCH /api/channels/:channelId/tasks/:taskId — update a task */
tasks.patch("/:taskId", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("channelId");
  const taskId = c.req.param("taskId");

  // Verify ownership and get task+channel info
  const channel = await c.env.DB.prepare(
    "SELECT id, openclaw_agent_id FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first<{ id: string; openclaw_agent_id: string }>();

  if (!channel) return c.json({ error: "Channel not found" }, 404);

  const existingTask = await c.env.DB.prepare(
    "SELECT id, kind, openclaw_cron_job_id, enabled FROM tasks WHERE id = ? AND channel_id = ?",
  )
    .bind(taskId, channelId)
    .first<{
      id: string;
      kind: string;
      openclaw_cron_job_id: string | null;
      enabled: number;
    }>();

  if (!existingTask) return c.json({ error: "Task not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    schedule?: string;
    instructions?: string;
    model?: string;
    enabled?: boolean;
  }>();

  // D1 only stores: name and enabled.
  // Schedule, instructions, model belong to OpenClaw — pushed via WebSocket.
  const sets: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    sets.push("name = ?");
    values.push(body.name.trim());
  }
  if (body.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(body.enabled ? 1 : 0);
  }

  if (sets.length > 0) {
    sets.push("updated_at = unixepoch()");
    values.push(taskId, channelId);
    await c.env.DB.prepare(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND channel_id = ?`,
    )
      .bind(...values)
      .run();
  }

  // Push OpenClaw-owned fields directly to OpenClaw for background tasks.
  // The client must send ALL OpenClaw fields (schedule, instructions, enabled)
  // together since they are not stored in D1.
  if (existingTask.kind === "background" && existingTask.openclaw_cron_job_id) {
    const needsPush = body.schedule !== undefined || body.instructions !== undefined || body.enabled !== undefined || body.model !== undefined;
    if (needsPush) {
      await pushScheduleToOpenClaw(c.env, userId, {
        taskId: taskId,
        openclawCronJobId: existingTask.openclaw_cron_job_id,
        agentId: channel.openclaw_agent_id,
        schedule: body.schedule ?? "",
        instructions: body.instructions ?? "",
        enabled: body.enabled ?? !!existingTask.enabled,
        model: body.model,
      });
    }
  }

  return c.json({ ok: true });
});

/** POST /api/channels/:channelId/tasks/:taskId/run — trigger a one-time immediate execution */
tasks.post("/:taskId/run", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("channelId");
  const taskId = c.req.param("taskId");

  // Verify ownership
  const channel = await c.env.DB.prepare(
    "SELECT id, openclaw_agent_id FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first<{ id: string; openclaw_agent_id: string }>();

  if (!channel) return c.json({ error: "Channel not found" }, 404);

  const task = await c.env.DB.prepare(
    "SELECT id, kind, openclaw_cron_job_id FROM tasks WHERE id = ? AND channel_id = ?",
  )
    .bind(taskId, channelId)
    .first<{
      id: string;
      kind: string;
      openclaw_cron_job_id: string | null;
    }>();

  if (!task) return c.json({ error: "Task not found" }, 404);
  if (task.kind !== "background") return c.json({ error: "Only background tasks can be triggered" }, 400);
  if (!task.openclaw_cron_job_id) return c.json({ error: "Task has no associated cron job" }, 400);

  // Send a task.run message to OpenClaw via ConnectionDO.
  // Instructions and model are not included — the plugin reads them
  // directly from OpenClaw's jobs.json (the single source of truth).
  try {
    const doId = c.env.CONNECTION_DO.idFromName(userId);
    const stub = c.env.CONNECTION_DO.get(doId);
    const resp = await stub.fetch(
      new Request("https://internal/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "task.run",
          cronJobId: task.openclaw_cron_job_id,
          agentId: channel.openclaw_agent_id,
        }),
      }),
    );

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Unknown error" }));
      return c.json({ error: (err as { error?: string }).error ?? "Failed to trigger task" }, 503);
    }
  } catch (err) {
    console.error("Failed to trigger task run:", err);
    return c.json({ error: "OpenClaw is not connected" }, 503);
  }

  return c.json({ ok: true, message: "Task triggered" });
});

/** DELETE /api/channels/:channelId/tasks/:taskId */
tasks.delete("/:taskId", async (c) => {
  const userId = c.get("userId");
  const channelId = c.req.param("channelId");
  const taskId = c.req.param("taskId");

  const channel = await c.env.DB.prepare(
    "SELECT id FROM channels WHERE id = ? AND user_id = ?",
  )
    .bind(channelId, userId)
    .first();

  if (!channel) return c.json({ error: "Channel not found" }, 404);

  // Get task to check if it's background (need to delete CronJob)
  const task = await c.env.DB.prepare(
    "SELECT kind, openclaw_cron_job_id FROM tasks WHERE id = ? AND channel_id = ?",
  )
    .bind(taskId, channelId)
    .first<{ kind: string; openclaw_cron_job_id: string | null }>();

  await c.env.DB.prepare(
    "DELETE FROM tasks WHERE id = ? AND channel_id = ?",
  )
    .bind(taskId, channelId)
    .run();

  // Delete associated jobs
  await c.env.DB.prepare("DELETE FROM jobs WHERE task_id = ?").bind(taskId).run();

  // Push delete to OpenClaw for background tasks
  if (task?.kind === "background" && task.openclaw_cron_job_id) {
    // Record the deletion so task.scan won't re-create the task
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO deleted_cron_jobs (cron_job_id, user_id) VALUES (?, ?)",
    )
      .bind(task.openclaw_cron_job_id, userId)
      .run();

    await pushDeleteToOpenClaw(c.env, userId, task.openclaw_cron_job_id);
  }

  return c.json({ ok: true });
});

export { tasks };
