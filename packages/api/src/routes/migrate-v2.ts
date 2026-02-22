import { Hono } from "hono";
import type { Env } from "../env.js";
import { generateId } from "../utils/id.js";

/**
 * One-time migration endpoint: converts legacy pairing_tokens into agents,
 * backfills channels.default_agent_id, and sets messages.sender_agent_id.
 *
 * POST /api/v2/migrate — idempotent, safe to run multiple times.
 * Only available in development mode.
 */
const migrateV2 = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

migrateV2.post("/", async (c) => {
  if (c.env.ENVIRONMENT !== "development") {
    return c.json({ error: "Migration endpoint only available in development" }, 403);
  }

  const userId = c.get("userId");
  const stats = { agentsCreated: 0, channelsUpdated: 0, messagesUpdated: 0, skipped: 0 };

  // Step 1: Migrate pairing_tokens → agents (skip if agent with same token already exists)
  const { results: tokens } = await c.env.DB.prepare(
    "SELECT id, token, label, last_connected_at, last_ip, connection_count FROM pairing_tokens WHERE user_id = ? AND revoked_at IS NULL",
  )
    .bind(userId)
    .all<{
      id: string;
      token: string;
      label: string | null;
      last_connected_at: number | null;
      last_ip: string | null;
      connection_count: number;
    }>();

  let defaultAgentId: string | null = null;

  for (const pt of tokens ?? []) {
    const existing = await c.env.DB.prepare(
      "SELECT id FROM agents WHERE pairing_token = ?",
    )
      .bind(pt.token)
      .first<{ id: string }>();

    if (existing) {
      if (!defaultAgentId) defaultAgentId = existing.id;
      stats.skipped++;
      continue;
    }

    const agentId = generateId("agt_");
    await c.env.DB.prepare(
      `INSERT INTO agents (id, user_id, name, type, role, pairing_token, capabilities,
        status, last_connected_at, last_ip, connection_count)
       VALUES (?, ?, ?, 'openclaw', 'general', ?, '["chat","streaming","cron","a2ui","media","code_edit","delegate"]',
        'disconnected', ?, ?, ?)`,
    )
      .bind(
        agentId,
        userId,
        pt.label ?? "OpenClaw",
        pt.token,
        pt.last_connected_at,
        pt.last_ip,
        pt.connection_count ?? 0,
      )
      .run();

    if (!defaultAgentId) defaultAgentId = agentId;
    stats.agentsCreated++;
  }

  // If no pairing tokens exist but user has no agents, skip backfill
  if (!defaultAgentId) {
    const anyAgent = await c.env.DB.prepare(
      "SELECT id FROM agents WHERE user_id = ? LIMIT 1",
    )
      .bind(userId)
      .first<{ id: string }>();
    defaultAgentId = anyAgent?.id ?? null;
  }

  // Step 2: Backfill channels.default_agent_id (set to first agent if null)
  if (defaultAgentId) {
    const { meta } = await c.env.DB.prepare(
      "UPDATE channels SET default_agent_id = ?, updated_at = unixepoch() WHERE user_id = ? AND default_agent_id IS NULL",
    )
      .bind(defaultAgentId, userId)
      .run();
    stats.channelsUpdated = meta.changes ?? 0;
  }

  // Step 3: Backfill messages.sender_agent_id for agent messages (set to default agent)
  if (defaultAgentId) {
    const { meta } = await c.env.DB.prepare(
      "UPDATE messages SET sender_agent_id = ? WHERE user_id = ? AND sender = 'agent' AND sender_agent_id IS NULL",
    )
      .bind(defaultAgentId, userId)
      .run();
    stats.messagesUpdated = meta.changes ?? 0;
  }

  return c.json({
    ok: true,
    defaultAgentId,
    stats,
  });
});

export { migrateV2 };
