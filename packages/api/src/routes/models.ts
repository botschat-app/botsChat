import { Hono } from "hono";
import type { Env } from "../env.js";

export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
};

const models = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

/** GET /api/models — list available models (fetched from OpenClaw plugin via DO) */
models.get("/", async (c) => {
  const userId = c.get("userId");
  const doId = c.env.CONNECTION_DO.idFromName(userId);
  const stub = c.env.CONNECTION_DO.get(doId);
  const res = await stub.fetch(new Request("https://internal/models"));
  const data = await res.json<{ models: ModelInfo[] }>();
  return c.json(data);
});

export { models };
