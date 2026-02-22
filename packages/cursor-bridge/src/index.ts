#!/usr/bin/env node
/**
 * BotsChat Cursor Bridge — connects Cursor Agent CLI to BotsChat Cloud.
 *
 * Receives user.message from BotsChat, spawns `agent -p --resume` CLI,
 * streams results back via agent.stream.* messages, and stores execution
 * traces (lv2/lv3) for the central history.
 *
 * Environment:
 *   BOTSCHAT_URL      - BotsChat Cloud URL (default: http://localhost:8788)
 *   BOTSCHAT_TOKEN    - Agent pairing token or API key
 *   BOTSCHAT_AGENT_ID - Agent ID from agents table (agt_xxx)
 *   CURSOR_WORKSPACE  - Workspace directory for Cursor CLI (default: cwd)
 *   CURSOR_AGENT_BIN  - Path to `agent` binary (default: "agent" from PATH)
 *   RG_PATH           - Path to ripgrep binary dir (for Cursor CLI)
 *
 * Usage:
 *   BOTSCHAT_URL=http://localhost:8788 \
 *   BOTSCHAT_TOKEN=bc_pat_xxx \
 *   BOTSCHAT_AGENT_ID=agt_xxx \
 *   node packages/cursor-bridge/dist/index.js
 */

import { BotsChatWSClient } from "./ws-client.js";
import { createChat, runAgent, type StreamEvent } from "./cli-runner.js";
import { randomUUID } from "crypto";

const BOTSCHAT_URL = process.env.BOTSCHAT_URL ?? "http://localhost:8788";
const BOTSCHAT_TOKEN = process.env.BOTSCHAT_TOKEN ?? "";
const BOTSCHAT_AGENT_ID = process.env.BOTSCHAT_AGENT_ID ?? "";
const CURSOR_WORKSPACE = process.env.CURSOR_WORKSPACE ?? process.cwd();

if (!BOTSCHAT_TOKEN) {
  console.error("Error: BOTSCHAT_TOKEN is required");
  process.exit(1);
}
if (!BOTSCHAT_AGENT_ID) {
  console.error("Error: BOTSCHAT_AGENT_ID is required");
  process.exit(1);
}

// Session mapping: sessionKey -> Cursor chatId
const sessionMap = new Map<string, string>();

// Active runs: sessionKey -> abort function
const activeRuns = new Map<string, () => void>();

const wsClient = new BotsChatWSClient({
  cloudUrl: BOTSCHAT_URL,
  pairingToken: BOTSCHAT_TOKEN,
  agentId: BOTSCHAT_AGENT_ID,
  onConnect: () => {
    console.log("[bridge] Connected to BotsChat Cloud");
    wsClient.sendJson({ type: "status", connected: true, agents: ["cursor-cli"] });
  },
  onDisconnect: () => {
    console.log("[bridge] Disconnected from BotsChat Cloud");
  },
  onMessage: async (msg) => {
    if (msg.type === "user.message") {
      await handleUserMessage(msg);
    } else if (msg.type === "task.scan.request") {
      wsClient.sendJson({ type: "task.scan.result", tasks: [] });
    } else if (msg.type === "models.request") {
      wsClient.sendJson({ type: "models.list", models: [] });
    }
  },
});

async function handleUserMessage(msg: Record<string, unknown>) {
  const sessionKey = msg.sessionKey as string;
  const text = msg.text as string;
  const messageId = (msg.messageId as string) ?? randomUUID();

  if (!text?.trim()) return;

  console.log(`[bridge] Received message: sessionKey=${sessionKey}, text=${text.substring(0, 80)}...`);

  // Abort any existing run for this session
  const existingAbort = activeRuns.get(sessionKey);
  if (existingAbort) {
    console.log(`[bridge] Aborting previous run for ${sessionKey}`);
    existingAbort();
    activeRuns.delete(sessionKey);
  }

  // Get or create Cursor chatId for this session
  let chatId = sessionMap.get(sessionKey);
  if (!chatId) {
    try {
      chatId = await createChat();
      sessionMap.set(sessionKey, chatId);
      console.log(`[bridge] Created new Cursor chat: ${chatId} for session ${sessionKey}`);
    } catch (err) {
      console.error(`[bridge] Failed to create chat:`, err);
      wsClient.sendJson({
        type: "agent.text",
        agentId: BOTSCHAT_AGENT_ID,
        sessionKey,
        text: `Failed to initialize Cursor session: ${err}`,
        messageId: randomUUID(),
      });
      return;
    }
  }

  // Spawn agent CLI
  const { abort } = runAgent({
    chatId,
    prompt: text,
    workspace: CURSOR_WORKSPACE,
    onEvent: (event: StreamEvent) => {
      switch (event.type) {
        case "agent.stream.start":
          wsClient.sendJson({
            type: "agent.stream.start",
            agentId: BOTSCHAT_AGENT_ID,
            sessionKey,
            runId: event.runId,
          });
          break;

        case "agent.stream.chunk":
          wsClient.sendJson({
            type: "agent.stream.chunk",
            agentId: BOTSCHAT_AGENT_ID,
            sessionKey,
            runId: event.runId,
            text: event.text,
          });
          break;

        case "agent.stream.end":
          wsClient.sendJson({
            type: "agent.text",
            agentId: BOTSCHAT_AGENT_ID,
            sessionKey,
            text: event.result ?? "",
            messageId: randomUUID(),
          });
          wsClient.sendJson({
            type: "agent.stream.end",
            agentId: BOTSCHAT_AGENT_ID,
            sessionKey,
            runId: event.runId,
          });
          activeRuns.delete(sessionKey);
          break;

        case "agent.trace":
          wsClient.sendJson({
            type: "agent.trace",
            agentId: BOTSCHAT_AGENT_ID,
            sessionKey,
            messageId,
            verboseLevel: event.verboseLevel,
            traceType: event.traceType,
            content: event.content,
            metadata: event.metadata,
          });
          break;

        case "error":
          console.error(`[bridge] Agent error: ${event.message}`);
          break;
      }
    },
  });

  activeRuns.set(sessionKey, abort);
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("[bridge] Shutting down...");
  for (const abort of activeRuns.values()) abort();
  wsClient.disconnect();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[bridge] Shutting down...");
  for (const abort of activeRuns.values()) abort();
  wsClient.disconnect();
  process.exit(0);
});

// Start
console.log(`[bridge] Cursor Bridge starting...`);
console.log(`[bridge]   Cloud URL: ${BOTSCHAT_URL}`);
console.log(`[bridge]   Agent ID: ${BOTSCHAT_AGENT_ID}`);
console.log(`[bridge]   Workspace: ${CURSOR_WORKSPACE}`);
wsClient.connect();
