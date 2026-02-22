import { Hono } from "hono";
import type { Env } from "../env.js";
import { generateId } from "../utils/id.js";

/**
 * Agents v2 API — agents are first-class entities (team members),
 * independent of channels. Each agent has a type (engine) and role (persona).
 */
const agentsV2 = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

export type AgentType = "openclaw" | "cursor_cli" | "cursor_cloud" | "claude_code" | "mock";

export type AgentV2 = {
  id: string;
  name: string;
  type: AgentType;
  role: string;
  systemPrompt: string;
  skills: Array<{ name: string; description: string }>;
  capabilities: string[];
  status: "connected" | "disconnected";
  lastConnectedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

const CAPABILITIES_BY_TYPE: Record<AgentType, string[]> = {
  openclaw: ["chat", "streaming", "cron", "a2ui", "media", "code_edit", "delegate"],
  cursor_cli: ["chat", "streaming", "code_edit"],
  cursor_cloud: ["chat", "code_edit"],
  claude_code: ["chat", "streaming", "code_edit"],
  mock: ["chat", "streaming"],
};

function dbRowToAgent(row: Record<string, unknown>): AgentV2 {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as AgentType,
    role: row.role as string,
    systemPrompt: row.system_prompt as string,
    skills: JSON.parse((row.skills_json as string) || "[]"),
    capabilities: JSON.parse((row.capabilities as string) || "[]"),
    status: (row.status as "connected" | "disconnected") ?? "disconnected",
    lastConnectedAt: row.last_connected_at as number | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/** GET /api/v2/agents — list all agents for the current user */
agentsV2.get("/", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, type, role, system_prompt, skills_json, capabilities,
            status, last_connected_at, created_at, updated_at
     FROM agents WHERE user_id = ? ORDER BY created_at ASC`,
  )
    .bind(userId)
    .all();

  return c.json({ agents: (results ?? []).map(dbRowToAgent) });
});

/** POST /api/v2/agents — create a new agent */
agentsV2.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    name: string;
    type: AgentType;
    role?: string;
    systemPrompt?: string;
    skills?: Array<{ name: string; description: string }>;
    pairingToken?: string;
    apiKey?: string;
    config?: Record<string, unknown>;
  }>();

  if (!body.name?.trim()) return c.json({ error: "Agent name is required" }, 400);
  if (!body.type) return c.json({ error: "Agent type is required" }, 400);

  const id = generateId("agt_");
  const capabilities = CAPABILITIES_BY_TYPE[body.type] ?? ["chat"];

  await c.env.DB.prepare(
    `INSERT INTO agents (id, user_id, name, type, role, system_prompt, skills_json,
      pairing_token, api_key, config_json, capabilities)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      body.name.trim(),
      body.type,
      body.role ?? "general",
      body.systemPrompt?.trim() ?? "",
      JSON.stringify(body.skills ?? []),
      body.pairingToken ?? null,
      body.apiKey ?? null,
      JSON.stringify(body.config ?? {}),
      JSON.stringify(capabilities),
    )
    .run();

  const row = await c.env.DB.prepare(
    `SELECT id, name, type, role, system_prompt, skills_json, capabilities,
            status, last_connected_at, created_at, updated_at
     FROM agents WHERE id = ?`,
  )
    .bind(id)
    .first();

  return c.json(dbRowToAgent(row!), 201);
});

/** GET /api/v2/agents/:id — get a single agent */
agentsV2.get("/:id", async (c) => {
  const userId = c.get("userId");
  const agentId = c.req.param("id");

  const row = await c.env.DB.prepare(
    `SELECT id, name, type, role, system_prompt, skills_json, capabilities,
            status, last_connected_at, created_at, updated_at
     FROM agents WHERE id = ? AND user_id = ?`,
  )
    .bind(agentId, userId)
    .first();

  if (!row) return c.json({ error: "Agent not found" }, 404);
  return c.json(dbRowToAgent(row));
});

/** PATCH /api/v2/agents/:id — update an agent */
agentsV2.patch("/:id", async (c) => {
  const userId = c.get("userId");
  const agentId = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    role?: string;
    systemPrompt?: string;
    skills?: Array<{ name: string; description: string }>;
    config?: Record<string, unknown>;
  }>();

  const sets: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) { sets.push("name = ?"); values.push(body.name.trim()); }
  if (body.role !== undefined) { sets.push("role = ?"); values.push(body.role); }
  if (body.systemPrompt !== undefined) { sets.push("system_prompt = ?"); values.push(body.systemPrompt.trim()); }
  if (body.skills !== undefined) { sets.push("skills_json = ?"); values.push(JSON.stringify(body.skills)); }
  if (body.config !== undefined) { sets.push("config_json = ?"); values.push(JSON.stringify(body.config)); }

  if (sets.length === 0) return c.json({ error: "No fields to update" }, 400);

  sets.push("updated_at = unixepoch()");
  values.push(agentId, userId);

  await c.env.DB.prepare(
    `UPDATE agents SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
  )
    .bind(...values)
    .run();

  const row = await c.env.DB.prepare(
    `SELECT id, name, type, role, system_prompt, skills_json, capabilities,
            status, last_connected_at, created_at, updated_at
     FROM agents WHERE id = ? AND user_id = ?`,
  )
    .bind(agentId, userId)
    .first();

  if (!row) return c.json({ error: "Agent not found" }, 404);
  return c.json(dbRowToAgent(row));
});

/** DELETE /api/v2/agents/:id — delete an agent */
agentsV2.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const agentId = c.req.param("id");

  const { meta } = await c.env.DB.prepare(
    "DELETE FROM agents WHERE id = ? AND user_id = ?",
  )
    .bind(agentId, userId)
    .run();

  if (!meta.changes) return c.json({ error: "Agent not found" }, 404);
  return c.json({ ok: true });
});

export { agentsV2 };
