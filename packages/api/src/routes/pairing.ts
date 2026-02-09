import { Hono } from "hono";
import type { Env } from "../env.js";
import { generateId, generatePairingToken } from "../utils/id.js";

const pairing = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

/** GET /api/pairing-tokens — list active (non-revoked) pairing tokens for the current user */
pairing.get("/", async (c) => {
  const userId = c.get("userId");

  const { results } = await c.env.DB.prepare(
    `SELECT id, token, label, last_connected_at, last_ip, connection_count, created_at
     FROM pairing_tokens
     WHERE user_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all<{
      id: string;
      token: string;
      label: string | null;
      last_connected_at: number | null;
      last_ip: string | null;
      connection_count: number;
      created_at: number;
    }>();

  return c.json({
    tokens: (results ?? []).map((r) => ({
      id: r.id,
      token: r.token,
      tokenPreview: `bc_pat_...${r.token.slice(-8)}`,
      label: r.label,
      lastConnectedAt: r.last_connected_at,
      lastIp: r.last_ip,
      connectionCount: r.connection_count,
      createdAt: r.created_at,
    })),
  });
});

/** POST /api/pairing-tokens — generate a new pairing token */
pairing.post("/", async (c) => {
  const userId = c.get("userId");
  const { label } = await c.req.json<{ label?: string }>().catch(() => ({
    label: undefined,
  }));

  const id = generateId("pt_");
  const token = generatePairingToken();

  await c.env.DB.prepare(
    "INSERT INTO pairing_tokens (id, user_id, token, label) VALUES (?, ?, ?, ?)",
  )
    .bind(id, userId, token, label?.trim() ?? null)
    .run();

  return c.json(
    {
      id,
      token, // Show full token only on creation
      label: label?.trim() ?? null,
    },
    201,
  );
});

/** DELETE /api/pairing-tokens/:id — soft-revoke a pairing token */
pairing.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const tokenId = c.req.param("id");

  // Soft-delete: set revoked_at instead of removing the row
  await c.env.DB.prepare(
    "UPDATE pairing_tokens SET revoked_at = unixepoch() WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
  )
    .bind(tokenId, userId)
    .run();

  return c.json({ ok: true });
});

export { pairing };
