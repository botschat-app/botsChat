import { Hono } from "hono";
import type { Env } from "../env.js";

/**
 * History Query API v2 — supports verbose-level filtering, agent filtering,
 * trace type filtering, and keyword search across messages + message_traces.
 *
 * GET /api/v2/messages/query?sessionKey=...&verboseLevel=1&limit=50
 */
const historyV2 = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

historyV2.get("/query", async (c) => {
  const userId = c.get("userId");
  const sessionKey = c.req.query("sessionKey");
  if (!sessionKey) return c.json({ error: "sessionKey required" }, 400);

  const verboseLevel = Math.min(Number(c.req.query("verboseLevel") ?? 1), 3);
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const senderFilter = c.req.query("senderFilter"); // "user" | "agent" | undefined
  const agentIdFilter = c.req.query("agentIdFilter");
  const traceTypeFilter = c.req.query("traceTypeFilter");
  const keyword = c.req.query("keyword");
  const beforeMessageId = c.req.query("beforeMessageId");

  // Build lv1 query (messages table)
  const conditions: string[] = ["m.session_key = ?", "m.user_id = ?"];
  const params: unknown[] = [sessionKey, userId];

  if (senderFilter === "user" || senderFilter === "agent") {
    conditions.push("m.sender = ?");
    params.push(senderFilter);
  }
  if (agentIdFilter) {
    conditions.push("(m.sender_agent_id = ? OR m.target_agent_id = ?)");
    params.push(agentIdFilter, agentIdFilter);
  }
  if (keyword) {
    conditions.push("m.text LIKE ?");
    params.push(`%${keyword}%`);
  }
  if (beforeMessageId) {
    conditions.push("m.created_at < (SELECT created_at FROM messages WHERE id = ?)");
    params.push(beforeMessageId);
  }

  params.push(limit);

  const { results: messages } = await c.env.DB.prepare(
    `SELECT m.id, m.sender, m.sender_agent_id, m.target_agent_id, m.text, m.media_url, m.encrypted, m.created_at
     FROM messages m
     WHERE ${conditions.join(" AND ")}
     ORDER BY m.created_at DESC
     LIMIT ?`,
  )
    .bind(...params)
    .all<{
      id: string;
      sender: string;
      sender_agent_id: string | null;
      target_agent_id: string | null;
      text: string;
      media_url: string | null;
      encrypted: number;
      created_at: number;
    }>();

  // Resolve agent names
  const agentIds = new Set<string>();
  for (const m of messages ?? []) {
    if (m.sender_agent_id) agentIds.add(m.sender_agent_id);
    if (m.target_agent_id) agentIds.add(m.target_agent_id);
  }

  const agentNames: Record<string, string> = {};
  if (agentIds.size > 0) {
    const placeholders = [...agentIds].map(() => "?").join(",");
    const { results: agents } = await c.env.DB.prepare(
      `SELECT id, name FROM agents WHERE id IN (${placeholders})`,
    )
      .bind(...agentIds)
      .all<{ id: string; name: string }>();
    for (const a of agents ?? []) {
      agentNames[a.id] = a.name;
    }
  }

  // Build response
  type MessageResponse = {
    id: string;
    sender: string;
    senderAgentId?: string;
    senderAgentName?: string;
    targetAgentId?: string;
    text: string;
    mediaUrl?: string;
    encrypted: boolean;
    timestamp: number;
    traces?: Array<{
      verboseLevel: number;
      traceType: string;
      content: string;
      metadata?: Record<string, unknown>;
    }>;
  };

  const result: MessageResponse[] = [];
  const messageIds = (messages ?? []).map((m) => m.id);

  // Fetch traces if verboseLevel >= 2
  let tracesByMessageId: Record<string, Array<{ verbose_level: number; trace_type: string; content: string; metadata_json: string }>> = {};

  if (verboseLevel >= 2 && messageIds.length > 0) {
    const traceConds: string[] = ["message_id IN (" + messageIds.map(() => "?").join(",") + ")"];
    const traceParams: unknown[] = [...messageIds];

    traceConds.push("verbose_level <= ?");
    traceParams.push(verboseLevel);

    if (traceTypeFilter) {
      traceConds.push("trace_type = ?");
      traceParams.push(traceTypeFilter);
    }
    if (agentIdFilter) {
      traceConds.push("agent_id = ?");
      traceParams.push(agentIdFilter);
    }

    const { results: traces } = await c.env.DB.prepare(
      `SELECT message_id, verbose_level, trace_type, content, metadata_json
       FROM message_traces
       WHERE ${traceConds.join(" AND ")}
       ORDER BY created_at ASC`,
    )
      .bind(...traceParams)
      .all<{ message_id: string; verbose_level: number; trace_type: string; content: string; metadata_json: string }>();

    for (const t of traces ?? []) {
      if (!tracesByMessageId[t.message_id]) tracesByMessageId[t.message_id] = [];
      tracesByMessageId[t.message_id].push(t);
    }
  }

  for (const m of messages ?? []) {
    const msg: MessageResponse = {
      id: m.id,
      sender: m.sender,
      senderAgentId: m.sender_agent_id ?? undefined,
      senderAgentName: m.sender_agent_id ? agentNames[m.sender_agent_id] : undefined,
      targetAgentId: m.target_agent_id ?? undefined,
      text: typeof m.text === "string" ? m.text : "",
      mediaUrl: m.media_url ?? undefined,
      encrypted: !!m.encrypted,
      timestamp: m.created_at,
    };

    if (verboseLevel >= 2 && tracesByMessageId[m.id]) {
      msg.traces = tracesByMessageId[m.id].map((t) => ({
        verboseLevel: t.verbose_level,
        traceType: t.trace_type,
        content: typeof t.content === "string" ? t.content : "",
        metadata: t.metadata_json ? JSON.parse(t.metadata_json) : undefined,
      }));
    }

    result.push(msg);
  }

  // Return in chronological order (query was DESC for LIMIT, reverse for output)
  result.reverse();

  return c.json({ messages: result, hasMore: (messages?.length ?? 0) === limit });
});

/** GET /api/v2/messages/traces/:messageId — fetch traces for a specific message */
historyV2.get("/traces/:messageId", async (c) => {
  const userId = c.get("userId");
  const messageId = c.req.param("messageId");
  const verboseLevel = Math.min(Number(c.req.query("verboseLevel") ?? 3), 3);

  // Verify message belongs to user
  const msg = await c.env.DB.prepare(
    "SELECT id FROM messages WHERE id = ? AND user_id = ?",
  )
    .bind(messageId, userId)
    .first();

  if (!msg) return c.json({ error: "Message not found" }, 404);

  const { results: traces } = await c.env.DB.prepare(
    `SELECT id, verbose_level, trace_type, content, metadata_json, agent_id, encrypted, created_at
     FROM message_traces
     WHERE message_id = ? AND verbose_level <= ?
     ORDER BY created_at ASC`,
  )
    .bind(messageId, verboseLevel)
    .all<{
      id: string;
      verbose_level: number;
      trace_type: string;
      content: string;
      metadata_json: string;
      agent_id: string;
      encrypted: number;
      created_at: number;
    }>();

  return c.json({
    traces: (traces ?? []).map((t) => ({
      id: t.id,
      verboseLevel: t.verbose_level,
      traceType: t.trace_type,
      content: typeof t.content === "string" ? t.content : "",
      metadata: t.metadata_json ? JSON.parse(t.metadata_json) : undefined,
      agentId: t.agent_id,
      encrypted: !!t.encrypted,
      timestamp: t.created_at,
    })),
  });
});

export { historyV2 };
