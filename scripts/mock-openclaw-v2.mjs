#!/usr/bin/env node
/**
 * Mock OpenClaw v2 — multi-agent aware mock for testing the full v2 architecture.
 *
 * Features:
 *   - Echoes back all received content + context (raw JSON dump)
 *   - Fetches L1/L2/L3 history via the v2 History API and returns it
 *   - Special trigger words for testing different capabilities
 *   - Sends agent.trace (lv2/lv3) to test verbose storage
 *   - Supports agentId in auth and all outbound messages
 *
 * Trigger words (in message text):
 *   /echo        — Echo back the raw message JSON (default behavior)
 *   /context     — Fetch and return channel context via History API
 *   /history     — Fetch L1 history (conclusions only) and return
 *   /history2    — Fetch L2 history (+ thinking process)
 *   /history3    — Fetch L3 history (+ tool calls / references)
 *   /agents      — List all available agents and their skills
 *   /delegate    — Simulate agent.request delegation to another agent
 *   /trace       — Send sample lv2 + lv3 traces
 *
 * Usage:
 *   node scripts/mock-openclaw-v2.mjs --token bc_pat_xxx --agent-id agt_xxx
 *   node scripts/mock-openclaw-v2.mjs --token bc_pat_xxx --agent-id agt_xxx --url http://localhost:8788
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    token:    { type: "string" },
    "agent-id": { type: "string" },
    url:      { type: "string", default: "http://localhost:8788" },
    "api-token": { type: "string" },
    agents:   { type: "string", default: "main" },
    delay:    { type: "string", default: "200" },
    model:    { type: "string", default: "mock/openclaw-v2" },
    help:     { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (args.help || !args.token || !args["agent-id"]) {
  console.log(`Mock OpenClaw v2 — multi-agent testing mock

Usage:
  node scripts/mock-openclaw-v2.mjs --token <pat> --agent-id <agt_xxx> [options]

Required:
  --token <pat>        Agent pairing token
  --agent-id <agt_xxx> Agent ID from agents table

Options:
  --url <url>          Server URL (default: http://localhost:8788)
  --api-token <jwt>    JWT token for History API (auto-acquired if not provided)
  --agents <list>      Comma-separated OpenClaw agent IDs (default: main)
  --delay <ms>         Reply delay (default: 200)
  --model <name>       Model name (default: mock/openclaw-v2)

Trigger words:
  /echo        Echo raw message JSON
  /context     Fetch channel context
  /history     Fetch L1 history
  /history2    Fetch L2 history (+ thinking)
  /history3    Fetch L3 history (+ tool calls)
  /agents      List available agents + skills
  /delegate    Simulate delegation to another agent
  /trace       Send sample traces (lv2 + lv3)`);
  process.exit(args.help ? 0 : 1);
}

const TOKEN       = args.token;
const AGENT_ID    = args["agent-id"];
const SERVER_URL  = args.url;
const OC_AGENTS   = args.agents.split(",").map(s => s.trim());
const DELAY_MS    = parseInt(args.delay, 10);
const MODEL       = args.model;
let API_TOKEN     = args["api-token"] || null;
let userId        = null;

// ── Colours ──
const c = {
  reset:"\x1b[0m", dim:"\x1b[2m", cyan:"\x1b[36m", green:"\x1b[32m",
  yellow:"\x1b[33m", red:"\x1b[31m", magenta:"\x1b[35m", blue:"\x1b[34m",
};
const ts = () => new Date().toISOString().slice(11, 23);
const logInfo  = (m) => console.log(`${c.dim}${ts()}${c.reset} ${c.cyan}▸${c.reset} ${m}`);
const logOk    = (m) => console.log(`${c.dim}${ts()}${c.reset} ${c.green}✔${c.reset} ${m}`);
const logWarn  = (m) => console.log(`${c.dim}${ts()}${c.reset} ${c.yellow}▲${c.reset} ${m}`);
const logErr   = (m) => console.log(`${c.dim}${ts()}${c.reset} ${c.red}✖${c.reset} ${m}`);
const logRecv  = (m) => console.log(`${c.dim}${ts()}${c.reset} ${c.magenta}◂${c.reset} ${m}`);
const logSend  = (m) => console.log(`${c.dim}${ts()}${c.reset} ${c.blue}▸${c.reset} ${m}`);

// ── HTTP helpers (for History API) ──

async function apiGet(path) {
  if (!API_TOKEN) {
    logWarn("No API token, trying dev-auth...");
    await acquireApiToken();
  }
  const res = await fetch(`${SERVER_URL}/api${path}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function acquireApiToken() {
  const DEV_SECRET = process.env.DEV_AUTH_SECRET || "botschat-local-dev-secret";
  const res = await fetch(`${SERVER_URL}/api/dev-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: DEV_SECRET, userId: userId || "u_v2test" }),
  });
  if (!res.ok) throw new Error(`dev-auth failed: ${res.status}`);
  const data = await res.json();
  API_TOKEN = data.token;
  logOk(`Acquired API token for ${data.userId}`);
}

// ── WebSocket ──

let ws = null;
let backoff = 1000;
let pingTimer = null;
let intentionalClose = false;

function buildWsUrl() {
  const host = SERVER_URL.replace(/^https?:\/\//, "");
  const scheme = SERVER_URL.startsWith("http://") ? "ws" : "wss";
  return `${scheme}://${host}/api/gateway/mock?token=${encodeURIComponent(TOKEN)}`;
}

function connect() {
  const url = buildWsUrl();
  logInfo(`Connecting to ${url.replace(/token=.*/, "token=***")}`);
  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    logInfo("Connected, sending auth with agentId...");
    send({ type: "auth", token: TOKEN, agentId: AGENT_ID, agentType: "openclaw", agents: OC_AGENTS, model: MODEL });
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      handleMessage(msg);
    } catch (e) {
      logErr(`Bad JSON: ${e.message}`);
    }
  });

  ws.addEventListener("close", (event) => {
    logWarn(`Disconnected: code=${event.code}`);
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (!intentionalClose) {
      logInfo(`Reconnecting in ${backoff}ms...`);
      setTimeout(() => { backoff = Math.min(backoff * 2, 30000); connect(); }, backoff);
    }
  });

  ws.addEventListener("error", (event) => logErr(`WS error: ${event.message || "unknown"}`));
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── Message handlers ──

function handleMessage(msg) {
  switch (msg.type) {
    case "auth.ok":
      userId = msg.userId;
      backoff = 1000;
      logOk(`Authenticated: userId=${userId}, agentId=${AGENT_ID}`);
      if (msg.availableAgents) {
        logInfo(`Available agents: ${msg.availableAgents.map(a => `${a.name}(${a.status})`).join(", ")}`);
      }
      pingTimer = setInterval(() => send({ type: "status", connected: true, agents: OC_AGENTS, model: MODEL }), 25000);
      break;
    case "auth.fail":
      logErr(`Auth failed: ${msg.reason}`);
      intentionalClose = true;
      ws?.close(4001);
      break;
    case "ping":
      send({ type: "pong" });
      break;
    case "user.message":
      logRecv(`[user.message] session=${msg.sessionKey} target=${msg.targetAgentId || "default"} text="${trunc(msg.text, 60)}"`);
      handleUserMessage(msg);
      break;
    case "user.action":
      logRecv(`[user.action] action=${msg.action}`);
      send({ type: "agent.text", agentId: AGENT_ID, sessionKey: msg.sessionKey, text: `Action: ${msg.action}`, messageId: randomUUID() });
      break;
    case "task.scan.request":
      send({ type: "task.scan.result", tasks: [] });
      break;
    case "models.request":
      send({ type: "models.list", models: [{ id: MODEL, name: "Mock OpenClaw v2", provider: "mock" }] });
      break;
    case "settings.defaultModel":
      send({ type: "defaultModel.updated", model: msg.defaultModel });
      break;
    case "settings.notifyPreview":
      break;
    case "agent.response":
      logRecv(`[agent.response] requestId=${msg.requestId} from=${msg.fromAgentId} text="${trunc(msg.text, 60)}"`);
      break;
    default:
      logWarn(`Unhandled: ${msg.type}`);
  }
}

// ── User message handler with trigger words ──

async function handleUserMessage(msg) {
  const text = (msg.text || "").trim();
  const sessionKey = msg.sessionKey;
  const messageId = msg.messageId || randomUUID();

  await sleep(DELAY_MS);

  // Parse trigger word
  const trigger = text.startsWith("/") ? text.split(/\s/)[0].toLowerCase() : null;

  try {
    switch (trigger) {
      case "/context":
        await handleContextQuery(sessionKey, messageId);
        break;
      case "/history":
        await handleHistoryQuery(sessionKey, messageId, 1);
        break;
      case "/history2":
        await handleHistoryQuery(sessionKey, messageId, 2);
        break;
      case "/history3":
        await handleHistoryQuery(sessionKey, messageId, 3);
        break;
      case "/agents":
        await handleAgentsQuery(sessionKey, messageId);
        break;
      case "/delegate":
        await handleDelegate(sessionKey, messageId, text);
        break;
      case "/trace":
        await handleTraceSample(sessionKey, messageId);
        break;
      default:
        // Default: echo back everything we received
        await handleEcho(msg, sessionKey, messageId);
    }
  } catch (err) {
    sendReply(sessionKey, `Error: ${err.message}`, messageId);
    logErr(`Handler error: ${err.message}`);
  }
}

// ── /echo — dump raw message ──

async function handleEcho(msg, sessionKey, messageId) {
  const dump = {
    received: {
      type: msg.type,
      sessionKey: msg.sessionKey,
      text: msg.text,
      userId: msg.userId,
      messageId: msg.messageId,
      targetAgentId: msg.targetAgentId,
      parentMessageId: msg.parentMessageId,
      parentText: msg.parentText,
      parentSender: msg.parentSender,
      context: msg.context,
      depth: msg.depth,
    },
    agent: { id: AGENT_ID, model: MODEL },
  };
  // Remove undefined keys
  for (const [k, v] of Object.entries(dump.received)) {
    if (v === undefined) delete dump.received[k];
  }

  const reply = `**Echo from ${AGENT_ID}**\n\nI received:\n\`\`\`json\n${JSON.stringify(dump, null, 2)}\n\`\`\`\n\nUse trigger words: \`/context\` \`/history\` \`/history2\` \`/history3\` \`/agents\` \`/delegate\` \`/trace\``;
  sendStreamingReply(sessionKey, reply, messageId);
}

// ── /context — fetch channel context ──

async function handleContextQuery(sessionKey, messageId) {
  logInfo("[/context] Fetching channel context...");
  const channels = await apiGet("/channels");
  const agents = await apiGet("/v2/agents");

  const reply = `**Channel Context**\n\n**Channels:**\n\`\`\`json\n${JSON.stringify(channels.channels, null, 2)}\n\`\`\`\n\n**Agents:**\n\`\`\`json\n${JSON.stringify(agents.agents.map(a => ({ id: a.id, name: a.name, type: a.type, role: a.role, status: a.status, skills: a.skills })), null, 2)}\n\`\`\``;
  sendStreamingReply(sessionKey, reply, messageId);
}

// ── /history, /history2, /history3 — fetch history at different verbose levels ──

async function handleHistoryQuery(sessionKey, messageId, level) {
  logInfo(`[/history${level > 1 ? level : ""}] Fetching L${level} history...`);
  const qs = `sessionKey=${encodeURIComponent(sessionKey)}&verboseLevel=${level}&limit=10`;
  const data = await apiGet(`/v2/messages/query?${qs}`);

  const levelLabel = { 1: "L1 (conclusions)", 2: "L2 (+ thinking)", 3: "L3 (+ references)" }[level];
  let reply = `**History — ${levelLabel}** (${data.messages.length} messages)\n\n`;

  for (const m of data.messages) {
    const sender = m.sender === "user" ? "You" : (m.senderAgentName || m.senderAgentId || "Agent");
    const time = new Date(m.timestamp * 1000).toLocaleTimeString();
    reply += `**[${time}] ${sender}:** ${trunc(m.text, 200)}\n`;

    if (m.traces && m.traces.length > 0) {
      for (const t of m.traces) {
        reply += `  _lv${t.verboseLevel} ${t.traceType}:_ ${trunc(t.content, 150)}\n`;
      }
    }
    reply += "\n";
  }

  reply += `_hasMore: ${data.hasMore}_`;
  sendStreamingReply(sessionKey, reply, messageId);
}

// ── /agents — list all agents with skills ──

async function handleAgentsQuery(sessionKey, messageId) {
  logInfo("[/agents] Fetching agent list...");
  const data = await apiGet("/v2/agents");

  let reply = `**Available Agents** (${data.agents.length})\n\n`;
  for (const a of data.agents) {
    const status = a.status === "connected" ? "🟢" : "⚫";
    reply += `${status} **${a.name}** (${a.type}, role: ${a.role})\n`;
    reply += `   ID: \`${a.id}\`\n`;
    if (a.skills.length > 0) {
      reply += `   Skills: ${a.skills.map(s => s.name).join(", ")}\n`;
    }
    reply += `   Capabilities: ${a.capabilities.join(", ")}\n\n`;
  }
  sendStreamingReply(sessionKey, reply, messageId);
}

// ── /delegate — simulate agent.request to another agent ──

async function handleDelegate(sessionKey, messageId, text) {
  // Parse: /delegate <agentId> <message>
  const parts = text.replace("/delegate", "").trim().split(/\s+/);
  if (parts.length < 2) {
    sendReply(sessionKey, "Usage: `/delegate <agentId> <message>`\n\nExample: `/delegate agt_xxx Please review this code`", messageId);
    return;
  }

  const targetId = parts[0];
  const delegateText = parts.slice(1).join(" ");
  const requestId = randomUUID();

  logInfo(`[/delegate] Sending agent.request to ${targetId}: "${trunc(delegateText, 40)}"`);

  // First, tell the user what we're doing
  sendReply(sessionKey, `Delegating to agent \`${targetId}\`:\n> ${delegateText}\n\n_Waiting for response..._`, randomUUID());

  // Send agent.request
  send({
    type: "agent.request",
    agentId: AGENT_ID,
    targetAgentId: targetId,
    sessionKey,
    text: delegateText,
    requestId,
    depth: 0,
    context: {
      summary: `User asked me to delegate this task. Original message: "${trunc(text, 200)}"`,
      constraints: ["Reply concisely"],
      expectedOutput: "Task result",
    },
  });
  logSend(`[agent.request] requestId=${requestId} target=${targetId}`);
}

// ── /trace — send sample lv2 + lv3 traces ──

async function handleTraceSample(sessionKey, messageId) {
  logInfo("[/trace] Sending sample traces...");

  // lv2: thinking
  send({
    type: "agent.trace", agentId: AGENT_ID, sessionKey, messageId,
    verboseLevel: 2, traceType: "thinking",
    content: "Analyzing user request... The user wants to test trace functionality. I should demonstrate lv2 (thinking) and lv3 (tool calls) traces.",
  });

  // lv2: planning
  send({
    type: "agent.trace", agentId: AGENT_ID, sessionKey, messageId,
    verboseLevel: 2, traceType: "planning",
    content: "Plan: 1) Send thinking trace 2) Send file_read trace 3) Send command_exec trace 4) Return summary",
  });

  // lv3: file_read
  send({
    type: "agent.trace", agentId: AGENT_ID, sessionKey, messageId,
    verboseLevel: 3, traceType: "file_read",
    content: "// packages/api/src/index.ts\nimport { Hono } from \"hono\";\nimport { cors } from \"hono/cors\";\n// ... (42 lines)",
    metadata: { path: "packages/api/src/index.ts", lines: 42 },
  });

  // lv3: command_exec
  send({
    type: "agent.trace", agentId: AGENT_ID, sessionKey, messageId,
    verboseLevel: 3, traceType: "command_exec",
    content: "$ npm test\n\n> botschat@0.1.0 test\n> vitest run\n\n✓ 12 tests passed\n✓ 0 tests failed",
    metadata: { command: "npm test", exitCode: 0 },
  });

  await sleep(100);

  const reply = `**Trace Sample Sent**\n\nI just sent 4 traces attached to this message:\n- lv2 **thinking**: Analysis of your request\n- lv2 **planning**: Execution plan\n- lv3 **file_read**: Read \`packages/api/src/index.ts\` (42 lines)\n- lv3 **command_exec**: Ran \`npm test\` (12 tests passed)\n\nUse \`/history2\` or \`/history3\` to see them in the history query.`;
  sendStreamingReply(sessionKey, reply, messageId);
  logSend("[agent.trace] 4 traces + reply sent");
}

// ── Reply helpers ──

function sendReply(sessionKey, text, messageId) {
  send({ type: "agent.text", agentId: AGENT_ID, sessionKey, text, messageId: messageId || randomUUID() });
  logSend(`[agent.text] "${trunc(text, 60)}"`);
}

async function sendStreamingReply(sessionKey, text, messageId) {
  const runId = randomUUID().slice(0, 8);
  send({ type: "agent.stream.start", agentId: AGENT_ID, sessionKey, runId });

  const words = text.split(" ");
  let accumulated = "";
  for (let i = 0; i < words.length; i++) {
    accumulated += (i > 0 ? " " : "") + words[i];
    send({ type: "agent.stream.chunk", agentId: AGENT_ID, sessionKey, runId, text: accumulated });
    if (i % 5 === 0) await sleep(20);
  }

  send({ type: "agent.text", agentId: AGENT_ID, sessionKey, text, messageId: messageId || randomUUID() });
  send({ type: "agent.stream.end", agentId: AGENT_ID, sessionKey, runId });
  logSend(`[stream] ${words.length} words`);
}

// ── Utils ──

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function trunc(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : (s || ""); }

// ── Shutdown ──

process.on("SIGINT", () => { intentionalClose = true; ws?.close(1000); process.exit(0); });
process.on("SIGTERM", () => { intentionalClose = true; ws?.close(1000); process.exit(0); });

// ── Start ──

console.log(`
${c.cyan}╭──────────────────────────────────────────╮
│       Mock OpenClaw v2 (Multi-Agent)     │
│     Testing with context & history       │
╰──────────────────────────────────────────╯${c.reset}
  Server:    ${SERVER_URL}
  Agent ID:  ${AGENT_ID}
  Token:     ${TOKEN.slice(0, 12)}***
  OC Agents: ${OC_AGENTS.join(", ")}
  Model:     ${MODEL}
  Delay:     ${DELAY_MS}ms

  ${c.green}Trigger words:${c.reset}
    /echo      Echo raw message JSON
    /context   Fetch channel context
    /history   L1 history (conclusions)
    /history2  L2 history (+ thinking)
    /history3  L3 history (+ references)
    /agents    List agents + skills
    /delegate  Agent-to-Agent delegation
    /trace     Send sample lv2/lv3 traces
`);

connect();
