#!/usr/bin/env node
/**
 * Mock OpenClaw — a lightweight WebSocket client that simulates an OpenClaw
 * plugin for local BotsChat development. No OpenClaw dependency required.
 *
 * Usage:
 *   node scripts/mock-openclaw.mjs --token bc_pat_xxx
 *   node scripts/mock-openclaw.mjs --token bc_pat_xxx --delay 500 --stream
 *
 * Options:
 *   --token <pat>      Pairing token (required)
 *   --url <url>        Server URL (default: http://localhost:8787)
 *   --agents <list>    Comma-separated agent IDs (default: main)
 *   --delay <ms>       Reply delay in ms (default: 300)
 *   --stream           Enable streaming replies (chunk by chunk)
 *   --model <name>     Default model name (default: mock/echo-1.0)
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

// ── CLI args ─────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    token:  { type: "string" },
    url:    { type: "string", default: "http://localhost:8787" },
    agents: { type: "string", default: "main" },
    delay:  { type: "string", default: "300" },
    stream: { type: "boolean", default: false },
    model:  { type: "string", default: "mock/echo-1.0" },
    help:   { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (args.help || !args.token) {
  console.log(`Mock OpenClaw — simulate an OpenClaw plugin for local testing

Usage:
  node scripts/mock-openclaw.mjs --token <pairing-token> [options]

Options:
  --token <pat>      Pairing token (required)
  --url <url>        Server URL (default: http://localhost:8787)
  --agents <list>    Comma-separated agent IDs (default: main)
  --delay <ms>       Reply delay in ms (default: 300)
  --stream           Enable streaming replies
  --model <name>     Default model name (default: mock/echo-1.0)
  -h, --help         Show this help`);
  process.exit(args.help ? 0 : 1);
}

const TOKEN      = args.token;
const SERVER_URL = args.url;
const AGENTS     = args.agents.split(",").map((s) => s.trim());
const DELAY_MS   = parseInt(args.delay, 10);
const STREAMING  = args.stream;
const MODEL      = args.model;

// ── Colours ──────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  dim:   "\x1b[2m",
  cyan:  "\x1b[36m",
  green: "\x1b[32m",
  yellow:"\x1b[33m",
  red:   "\x1b[31m",
  magenta:"\x1b[35m",
};

function log(icon, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`${c.dim}${ts}${c.reset} ${icon} ${msg}`);
}
const logInfo  = (msg) => log(`${c.cyan}▸${c.reset}`, msg);
const logOk    = (msg) => log(`${c.green}✔${c.reset}`, msg);
const logWarn  = (msg) => log(`${c.yellow}▲${c.reset}`, msg);
const logErr   = (msg) => log(`${c.red}✖${c.reset}`, msg);
const logRecv  = (msg) => log(`${c.magenta}◂${c.reset}`, msg);
const logSend  = (msg) => log(`${c.cyan}▸${c.reset}`, msg);

// ── Mock models ──────────────────────────────────────────────────────

const MOCK_MODELS = [
  { id: "mock/echo-1.0",       name: "Echo 1.0",       provider: "mock" },
  { id: "mock/echo-streaming",  name: "Echo Streaming",  provider: "mock" },
  { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
  { id: "openai/gpt-4o",       name: "GPT-4o",          provider: "openai" },
];

// ── WebSocket connection ─────────────────────────────────────────────

const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;
let backoff = MIN_BACKOFF;
let ws = null;
let pingTimer = null;
let intentionalClose = false;
let userId = null;
let notifyPreview = false;

function buildWsUrl() {
  let host = SERVER_URL.replace(/^https?:\/\//, "");
  const isPlainHttp = SERVER_URL.startsWith("http://");
  const scheme = isPlainHttp ? "ws" : "wss";
  return `${scheme}://${host}/api/gateway/mock?token=${encodeURIComponent(TOKEN)}`;
}

function connect() {
  const url = buildWsUrl();
  logInfo(`Connecting to ${url.replace(/token=.*/, "token=***")}`);

  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    logInfo("Connected, sending auth…");
    send({ type: "auth", token: TOKEN, agents: AGENTS, model: MODEL });
  });

  ws.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : event.data.toString();
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      logErr(`Bad JSON: ${data.slice(0, 100)}`);
      return;
    }
    handleMessage(msg);
  });

  ws.addEventListener("close", (event) => {
    logWarn(`Disconnected: code=${event.code} reason=${event.reason || "?"}`);
    stopPing();
    if (!intentionalClose) scheduleReconnect();
  });

  ws.addEventListener("error", (event) => {
    logErr(`WebSocket error: ${event.message || "unknown"}`);
  });
}

function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function scheduleReconnect() {
  logInfo(`Reconnecting in ${backoff}ms…`);
  setTimeout(() => {
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
    connect();
  }, backoff);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    send({ type: "status", connected: true, agents: AGENTS, model: MODEL });
  }, 25_000);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

// ── Message handlers ─────────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
    case "auth.ok":
      userId = msg.userId;
      backoff = MIN_BACKOFF;
      logOk(`Authenticated (userId=${userId})`);
      startPing();
      break;

    case "auth.fail":
      logErr(`Auth failed: ${msg.reason}`);
      intentionalClose = true;
      ws?.close(4001, "auth failed");
      break;

    case "ping":
      send({ type: "pong" });
      break;

    case "user.message":
      logRecv(`[user.message] sessionKey=${msg.sessionKey} text="${truncate(msg.text, 80)}"`);
      handleUserMessage(msg);
      break;

    case "user.media":
      logRecv(`[user.media] sessionKey=${msg.sessionKey} url=${msg.mediaUrl}`);
      setTimeout(() => {
        send({
          type: "agent.text",
          sessionKey: msg.sessionKey,
          text: `📎 Received media: ${msg.mediaUrl}`,
          messageId: randomUUID(),
        });
        logSend("[agent.text] media acknowledgement");
      }, DELAY_MS);
      break;

    case "user.command":
      logRecv(`[user.command] command=${msg.command} args=${msg.args || ""}`);
      setTimeout(() => {
        send({
          type: "agent.text",
          sessionKey: msg.sessionKey,
          text: `Command received: /${msg.command} ${msg.args || ""}`.trim(),
          messageId: randomUUID(),
        });
      }, DELAY_MS);
      break;

    case "user.action":
      logRecv(`[user.action] action=${msg.action} params=${JSON.stringify(msg.params)}`);
      setTimeout(() => {
        send({
          type: "agent.text",
          sessionKey: msg.sessionKey,
          text: `Action received: ${msg.action}`,
          messageId: randomUUID(),
        });
      }, DELAY_MS);
      break;

    case "task.scan.request":
      logRecv("[task.scan.request]");
      send({ type: "task.scan.result", tasks: [] });
      logSend("[task.scan.result] empty tasks");
      break;

    case "models.request":
      logRecv("[models.request]");
      send({ type: "models.list", models: MOCK_MODELS });
      logSend(`[models.list] ${MOCK_MODELS.length} models`);
      break;

    case "task.schedule":
      logRecv(`[task.schedule] cronJobId=${msg.cronJobId} schedule=${msg.schedule}`);
      send({
        type: "task.schedule.ack",
        cronJobId: msg.cronJobId || `mock_cron_${Date.now()}`,
        taskId: msg.taskId,
        ok: true,
      });
      logSend("[task.schedule.ack] ok");
      break;

    case "task.delete":
      logRecv(`[task.delete] cronJobId=${msg.cronJobId}`);
      break;

    case "task.run":
      logRecv(`[task.run] cronJobId=${msg.cronJobId}`);
      handleTaskRun(msg);
      break;

    case "settings.defaultModel":
      logRecv(`[settings.defaultModel] model=${msg.defaultModel}`);
      send({ type: "defaultModel.updated", model: msg.defaultModel });
      logSend(`[defaultModel.updated] ${msg.defaultModel}`);
      break;

    case "settings.notifyPreview":
      notifyPreview = msg.enabled === true;
      logRecv(`[settings.notifyPreview] enabled=${notifyPreview}`);
      break;

    default:
      logWarn(`Unhandled message type: ${msg.type}`);
  }
}

// ── User message reply ───────────────────────────────────────────────

async function handleUserMessage(msg) {
  const replyText = `Mock reply: ${msg.text}`;

  await sleep(DELAY_MS);

  if (STREAMING) {
    const runId = randomUUID();
    send({ type: "agent.stream.start", sessionKey: msg.sessionKey, runId });

    // Simulate reasoning/thinking
    send({
      type: "agent.activity",
      sessionKey: msg.sessionKey,
      runId,
      kind: "reasoning",
      text: `Analyzing the user's message: "${truncate(msg.text, 60)}".\nLet me think about how to respond…`,
    });
    logSend("[agent.activity] reasoning");
    await sleep(200);

    // Simulate a tool call
    send({
      type: "agent.activity",
      sessionKey: msg.sessionKey,
      runId,
      kind: "tool_start",
      toolName: "web_search",
    });
    logSend("[agent.activity] tool_start: web_search");
    await sleep(800);

    send({
      type: "agent.activity",
      sessionKey: msg.sessionKey,
      runId,
      kind: "tool_end",
      toolName: "web_search",
      durationMs: 800,
      text: `Found 3 relevant results for: "${truncate(msg.text, 40)}"`,
    });
    logSend("[agent.activity] tool_end: web_search");
    await sleep(100);

    // Stream the reply text
    const words = replyText.split(" ");
    for (let i = 0; i < words.length; i++) {
      await sleep(50);
      const chunk = (i === 0 ? "" : " ") + words[i];
      send({ type: "agent.stream.chunk", sessionKey: msg.sessionKey, runId, text: chunk });
    }

    send({ type: "agent.stream.end", sessionKey: msg.sessionKey, runId });
    logSend(`[agent.stream] ${words.length} chunks`);

    send({
      type: "agent.text",
      sessionKey: msg.sessionKey,
      text: replyText,
      messageId: randomUUID(),
    });
  } else {
    const msgPayload = {
      type: "agent.text",
      sessionKey: msg.sessionKey,
      text: replyText,
      messageId: randomUUID(),
    };
    if (notifyPreview) {
      msgPayload.notifyPreview = truncate(replyText, 100);
    }
    send(msgPayload);
    logSend(`[agent.text] "${truncate(replyText, 60)}"${notifyPreview ? " +preview" : ""}`);
  }
}

// ── Task run simulation ──────────────────────────────────────────────

async function handleTaskRun(msg) {
  const jobId = `mock_job_${Date.now()}`;
  const sessionKey = `agent:${msg.agentId || "main"}:botschat:${userId}:task:mock`;
  const startedAt = Math.floor(Date.now() / 1000);

  send({
    type: "job.update",
    cronJobId: msg.cronJobId,
    jobId,
    sessionKey,
    status: "running",
    startedAt,
  });
  logSend(`[job.update] running jobId=${jobId}`);

  send({ type: "job.output", cronJobId: msg.cronJobId, jobId, text: "Mock job started…\n" });
  await sleep(1000);
  send({ type: "job.output", cronJobId: msg.cronJobId, jobId, text: "Mock job processing…\n" });
  await sleep(1000);
  send({ type: "job.output", cronJobId: msg.cronJobId, jobId, text: "Mock job complete.\n" });

  const finishedAt = Math.floor(Date.now() / 1000);
  send({
    type: "job.update",
    cronJobId: msg.cronJobId,
    jobId,
    sessionKey,
    status: "ok",
    summary: "Mock task executed successfully",
    startedAt,
    finishedAt,
    durationMs: (finishedAt - startedAt) * 1000,
  });
  logSend(`[job.update] ok (${finishedAt - startedAt}s)`);
}

// ── Utilities ────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : s; }

// ── Graceful shutdown ────────────────────────────────────────────────

function shutdown() {
  logInfo("Shutting down…");
  intentionalClose = true;
  stopPing();
  ws?.close(1000, "shutdown");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Start ────────────────────────────────────────────────────────────

console.log(`
${c.cyan}╭──────────────────────────────────────╮
│        Mock OpenClaw v1.0            │
│   Local testing without deployment   │
╰──────────────────────────────────────╯${c.reset}
  Server:    ${SERVER_URL}
  Token:     ${TOKEN.slice(0, 12)}***
  Agents:    ${AGENTS.join(", ")}
  Model:     ${MODEL}
  Delay:     ${DELAY_MS}ms
  Streaming: ${STREAMING}
`);

connect();
