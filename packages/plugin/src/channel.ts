import {
  deleteBotsChatAccount,
  listBotsChatAccountIds,
  resolveBotsChatAccount,
  resolveDefaultBotsChatAccountId,
  setBotsChatAccountEnabled,
} from "./accounts.js";
import { getBotsChatRuntime } from "./runtime.js";
import type { BotsChatChannelConfig, CloudInbound, ResolvedBotsChatAccount } from "./types.js";
import { BotsChatCloudClient } from "./ws-client.js";

// ---------------------------------------------------------------------------
// A2UI message-tool hints — injected via agentPrompt.messageToolHints so
// the agent knows it can output interactive UI components.  These strings
// end up inside the "message" tool documentation section of the system
// prompt, which the model pays close attention to.
// ---------------------------------------------------------------------------

const A2UI_MESSAGE_TOOL_HINTS: string[] = [
  "- This channel renders ```action fenced code blocks as interactive clickable widgets. When your reply offers choices, next steps, or confirmations, you MUST wrap a single-line JSON in an ```action fence instead of using plain-text option lists.",
  "- Action block format: ```action\\n{\"kind\":\"buttons\",\"prompt\":\"What next?\",\"items\":[{\"label\":\"Do X\",\"value\":\"x\",\"style\":\"primary\"},{\"label\":\"Do Y\",\"value\":\"y\"}]}\\n``` — kinds: buttons, confirm, select, input. Styles: \"primary\", \"danger\", or omit.",
  "- NEVER present selectable options as plain-text lists with bullets, numbers, or emojis (✅ • - 🔧 etc.) — they are NOT clickable. Always use an ```action block for choices. Skip action blocks only for purely informational replies.",
];

// ---------------------------------------------------------------------------
// Helper: read agent model from OpenClaw config
// ---------------------------------------------------------------------------
function readAgentModel(_agentId: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("os");
    const configFile = path.join(os.homedir(), ".openclaw", "openclaw.json");
    if (fs.existsSync(configFile)) {
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      const primary = cfg?.agents?.defaults?.model?.primary;
      if (primary) return primary;
    }
  } catch { /* ignore */ }
  return undefined;
}

// ---------------------------------------------------------------------------
// Connection registry — maps accountId → live WSS client
// ---------------------------------------------------------------------------
const cloudClients = new Map<string, BotsChatCloudClient>();
/** Maps accountId → cloudUrl so handleCloudMessage can resolve relative URLs */
const cloudUrls = new Map<string, string>();

function getCloudClient(accountId: string): BotsChatCloudClient | undefined {
  return cloudClients.get(accountId);
}

// ---------------------------------------------------------------------------
// ChannelPlugin definition
// ---------------------------------------------------------------------------

export const botschatPlugin = {
  id: "botschat" as const,

  meta: {
    id: "botschat",
    label: "BotsChat",
    selectionLabel: "BotsChat (cloud)",
    docsPath: "/channels/botschat",
    docsLabel: "botschat",
    blurb: "Cloud-based multi-channel chat interface",
    order: 80,
    quickstartAllowFrom: false,
  },

  capabilities: {
    chatTypes: ["direct", "group", "thread"] as string[],
    polls: false,
    reactions: false,
    threads: true,
    media: true,
  },

  agentPrompt: {
    messageToolHints: () => A2UI_MESSAGE_TOOL_HINTS,
  },

  reload: { configPrefixes: ["channels.botschat"] },

  config: {
    listAccountIds: (cfg: unknown) => listBotsChatAccountIds(cfg),
    resolveAccount: (cfg: unknown, accountId?: string | null) =>
      resolveBotsChatAccount(cfg, accountId),
    defaultAccountId: (cfg: unknown) => resolveDefaultBotsChatAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }: { cfg: unknown; accountId: string; enabled: boolean }) =>
      setBotsChatAccountEnabled(cfg, accountId, enabled),
    deleteAccount: ({ cfg, accountId }: { cfg: unknown; accountId: string }) =>
      deleteBotsChatAccount(cfg, accountId),
    isConfigured: (account: ResolvedBotsChatAccount) => account.configured,
    isEnabled: (account: ResolvedBotsChatAccount) => account.enabled,
    describeAccount: (account: ResolvedBotsChatAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.cloudUrl,
    }),
  },

  outbound: {
    deliveryMode: "direct" as const,

    sendText: async (ctx: {
      to: string;
      text: string;
      replyToId?: string | null;
      threadId?: string | number | null;
      accountId?: string | null;
    }) => {
      const client = getCloudClient(ctx.accountId ?? "default");
      if (!client?.connected) {
        return { ok: false, error: new Error("Not connected to BotsChat cloud") };
      }
      client.send({
        type: "agent.text",
        sessionKey: ctx.to,
        text: ctx.text,
        replyToId: ctx.replyToId ?? undefined,
        threadId: ctx.threadId?.toString(),
      });
      return { ok: true };
    },

    sendMedia: async (ctx: {
      to: string;
      text: string;
      mediaUrl?: string;
      accountId?: string | null;
    }) => {
      const client = getCloudClient(ctx.accountId ?? "default");
      if (!client?.connected) {
        return { ok: false, error: new Error("Not connected to BotsChat cloud") };
      }
      if (ctx.mediaUrl) {
        client.send({
          type: "agent.media",
          sessionKey: ctx.to,
          mediaUrl: ctx.mediaUrl,
          caption: ctx.text || undefined,
        });
      } else {
        client.send({
          type: "agent.text",
          sessionKey: ctx.to,
          text: ctx.text,
        });
      }
      return { ok: true };
    },
  },

  gateway: {
    startAccount: async (ctx: {
      cfg: unknown;
      accountId: string;
      account: ResolvedBotsChatAccount;
      runtime: unknown;
      abortSignal: AbortSignal;
      log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
      getStatus: () => Record<string, unknown>;
      setStatus: (s: Record<string, unknown>) => void;
    }) => {
      const { account, accountId, log } = ctx;

      if (!account.configured) {
        log?.warn(`[${accountId}] BotsChat not configured — skipping`);
        return;
      }

      ctx.setStatus({
        ...ctx.getStatus(),
        accountId,
        baseUrl: account.cloudUrl,
        running: true,
        lastStartAt: Date.now(),
      });

      log?.info(`[${accountId}] Starting BotsChat connection to ${account.cloudUrl}`);

      const client = new BotsChatCloudClient({
        cloudUrl: account.cloudUrl,
        accountId,
        pairingToken: account.pairingToken,
        getModel: () => readAgentModel("main"),
        onMessage: (msg: CloudInbound) => {
          handleCloudMessage(msg, ctx);
        },
        onStatusChange: (connected: boolean) => {
          ctx.setStatus({
            ...ctx.getStatus(),
            connected,
            ...(connected
              ? { lastConnectedAt: Date.now() }
              : { lastDisconnect: { at: Date.now() } }),
          });
        },
        log,
      });

      cloudClients.set(accountId, client);
      cloudUrls.set(accountId, account.cloudUrl);
      client.connect();

      ctx.abortSignal.addEventListener("abort", () => {
        client.disconnect();
        cloudClients.delete(accountId);
        cloudUrls.delete(accountId);
      });

      return client;
    },

    stopAccount: async (ctx: {
      accountId: string;
      getStatus: () => Record<string, unknown>;
      setStatus: (s: Record<string, unknown>) => void;
    }) => {
      const client = cloudClients.get(ctx.accountId);
      if (client) {
        client.disconnect();
        cloudClients.delete(ctx.accountId);
      }
      ctx.setStatus({
        ...ctx.getStatus(),
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
    },
  },

  threading: {
    resolveReplyToMode: () => "all" as const,
    buildToolContext: ({ context, hasRepliedRef }: {
      context: { To?: string; MessageThreadId?: string | number; ReplyToId?: string };
      hasRepliedRef?: { value: boolean };
    }) => ({
      currentChannelId: context.To?.trim() || undefined,
      currentChannelProvider: "botschat",
      currentThreadTs: context.MessageThreadId != null ? String(context.MessageThreadId) : context.ReplyToId,
      hasRepliedRef,
    }),
  },

  pairing: {
    idLabel: "botsChatUserId",
    normalizeAllowEntry: (entry: string) => entry.trim().toLowerCase(),
  },

  security: {
    resolveDmPolicy: (_ctx: { account: ResolvedBotsChatAccount }) => ({
      policy: "token",
      allowFrom: [] as string[],
      policyPath: "channels.botschat.pairingToken",
      allowFromPath: "channels.botschat.dm.allowFrom",
      approveHint: "Pair via BotsChat cloud dashboard (get a pairing token at console.botschat.app)",
    }),
  },

  setup: {
    applyAccountConfig: ({ cfg, input }: {
      cfg: unknown;
      accountId: string;
      input: { url?: string; token?: string; name?: string; useEnv?: boolean };
    }) => {
      const c = cfg as BotsChatChannelConfig;
      return {
        ...(c as Record<string, unknown>),
        channels: {
          ...c?.channels,
          botschat: {
            ...c?.channels?.botschat,
            enabled: true,
            cloudUrl: input.url?.trim() ?? c?.channels?.botschat?.cloudUrl ?? "",
            pairingToken: input.token?.trim() ?? c?.channels?.botschat?.pairingToken ?? "",
            ...(input.name ? { name: input.name.trim() } : {}),
          },
        },
      };
    },

    validateInput: ({ input }: {
      cfg: unknown;
      accountId: string;
      input: { url?: string; token?: string; useEnv?: boolean };
    }) => {
      if (input.useEnv) return null;
      if (!input.url?.trim()) return "BotsChat requires --url (e.g., --url console.botschat.app)";
      if (!input.token?.trim()) return "BotsChat requires --token (pairing token from console.botschat.app)";
      return null;
    },
  },

  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      connected: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }: {
      account: ResolvedBotsChatAccount;
      cfg: unknown;
      runtime?: Record<string, unknown>;
    }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.cloudUrl,
      running: (runtime?.running as boolean) ?? false,
      connected: (runtime?.connected as boolean) ?? false,
      lastStartAt: (runtime?.lastStartAt as number) ?? null,
      lastStopAt: (runtime?.lastStopAt as number) ?? null,
      lastError: (runtime?.lastError as string) ?? null,
      lastConnectedAt: (runtime?.lastConnectedAt as number) ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
    }),
    collectStatusIssues: (accounts: Array<{ accountId: string; lastError?: string | null; connected?: boolean; configured?: boolean }>) =>
      accounts.flatMap((a) => {
        const issues: Array<{ channel: string; accountId: string; kind: string; message: string }> = [];
        if (!a.configured) {
          issues.push({
            channel: "botschat",
            accountId: a.accountId,
            kind: "config",
            message: 'Not configured. Run "openclaw channel setup botschat --url <cloud-url> --token <pairing-token>"',
          });
        }
        if (a.lastError) {
          issues.push({ channel: "botschat", accountId: a.accountId, kind: "runtime", message: `Channel error: ${a.lastError}` });
        }
        return issues;
      }),
  },
} as const;

// ---------------------------------------------------------------------------
// Incoming message handler — dispatches cloud messages into the OpenClaw
// agent pipeline via the runtime.
// ---------------------------------------------------------------------------

async function handleCloudMessage(
  msg: CloudInbound,
  ctx: {
    cfg: unknown;
    accountId: string;
    runtime: unknown;
    log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  },
): Promise<void> {
  switch (msg.type) {
    case "user.message": {
      ctx.log?.info(`[${ctx.accountId}] Message from ${msg.userId}: ${msg.text.slice(0, 80)}${msg.mediaUrl ? " [+image]" : ""}`);

      try {
        const runtime = getBotsChatRuntime();

        // Load current config
        const cfg = runtime.config?.loadConfig?.() ?? ctx.cfg;

        // Extract threadId from sessionKey pattern: ....:thread:{threadId}
        const threadMatch = msg.sessionKey.match(/:thread:(.+)$/);
        const threadId = threadMatch ? threadMatch[1] : undefined;

        // Build the MsgContext that OpenClaw's dispatch pipeline expects.
        // BotsChat users are authenticated (logged in via the web UI), so
        // mark commands as authorized — this lets directives like /model
        // pass through the command-auth pipeline instead of being silently
        // dropped (the default is false / deny).
        const msgCtx: Record<string, unknown> = {
          Body: msg.text,
          RawBody: msg.text,
          CommandBody: msg.text,
          BodyForCommands: msg.text,
          From: `botschat:${msg.userId}`,
          To: msg.sessionKey,
          SessionKey: msg.sessionKey,
          AccountId: ctx.accountId,
          MessageSid: msg.messageId,
          ChatType: threadId ? "thread" : "direct",
          Channel: "botschat",
          MessageChannel: "botschat",
          Provider: "botschat",
          Surface: "botschat",
          CommandAuthorized: true,
          // A2UI format instructions are injected via agentPrompt.messageToolHints
          // (inside the message tool docs in the system prompt) — no GroupSystemPrompt needed.
          ...(threadId ? { MessageThreadId: threadId, ReplyToId: threadId } : {}),
          // Include image URL if the user sent an image.
          // Resolve relative URLs (e.g. /api/media/...) to absolute using cloudUrl
          // so OpenClaw can fetch the image from the BotsChat cloud.
          ...(msg.mediaUrl ? (() => {
            let resolvedUrl = msg.mediaUrl;
            if (resolvedUrl.startsWith("/")) {
              const baseUrl = cloudUrls.get(ctx.accountId);
              if (baseUrl) {
                resolvedUrl = baseUrl.replace(/\/$/, "") + resolvedUrl;
              }
            }
            return { MediaUrl: resolvedUrl, NumMedia: "1" };
          })() : {}),
        };

        // Finalize the context (normalizes fields, resolves agent route)
        const finalizedCtx = runtime.channel.reply.finalizeInboundContext(msgCtx);

      // Create a reply dispatcher that sends responses back through the cloud WSS
      const client = getCloudClient(ctx.accountId);
      const deliver = async (payload: { text?: string; mediaUrl?: string }) => {
        if (!client?.connected) return;
        if (payload.mediaUrl) {
          client.send({
            type: "agent.media",
            sessionKey: msg.sessionKey,
            mediaUrl: payload.mediaUrl,
            caption: payload.text,
            threadId,
          });
        } else if (payload.text) {
          client.send({
            type: "agent.text",
            sessionKey: msg.sessionKey,
            text: payload.text,
            threadId,
          });
          // Detect model-change confirmations and emit model.changed
          // Handles both formats:
          //   "Model set to provider/model."  (no parentheses)
          //   "Model set to Friendly Name (provider/model)."  (with parentheses)
          const modelMatch = payload.text.match(
            /Model (?:set to|reset to default)\b.*?([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)/,
          );
          if (modelMatch) {
            client.send({
              type: "model.changed",
              model: modelMatch[1],
              sessionKey: msg.sessionKey,
            });
          }
        }
      };

      // --- Streaming support ---
      // Generate a runId to correlate stream events for this reply.
      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let streamStarted = false;

      const onPartialReply = (payload: { text?: string }) => {
        if (!client?.connected || !payload.text) return;
        // Send stream start on first chunk
        if (!streamStarted) {
          streamStarted = true;
          client.send({
            type: "agent.stream.start",
            sessionKey: msg.sessionKey,
            runId,
          });
        }
        // Send the accumulated text so far
        client.send({
          type: "agent.stream.chunk",
          sessionKey: msg.sessionKey,
          runId,
          text: payload.text,
        });
      };

      // Use dispatchReplyFromConfig with a simple dispatcher
      const { dispatcher, replyOptions, markDispatchIdle } =
        runtime.channel.reply.createReplyDispatcherWithTyping({
          deliver: async (payload: unknown) => {
            // The payload from the dispatcher is a ReplyPayload
            const p = payload as { text?: string; mediaUrl?: string };
            await deliver(p);
          },
          onTypingStart: () => {},
          onTypingStop: () => {},
        });

      await runtime.channel.reply.dispatchReplyFromConfig({
        ctx: finalizedCtx,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          onPartialReply,
          allowPartialStream: true,
        },
      });

      // Send stream end if streaming was active
      if (streamStarted && client?.connected) {
        client.send({
          type: "agent.stream.end",
          sessionKey: msg.sessionKey,
          runId,
        });
      }

      markDispatchIdle();
      } catch (err) {
        ctx.log?.error(`[${ctx.accountId}] Failed to dispatch message: ${err}`);
      }
      break;
    }

    case "user.command":
      ctx.log?.info(`[${ctx.accountId}] Command /${msg.command} in session ${msg.sessionKey}`);
      // Commands are handled the same way — feed as a message with / prefix
      await handleCloudMessage(
        {
          type: "user.message",
          sessionKey: msg.sessionKey,
          text: `/${msg.command}${msg.args ? ` ${msg.args}` : ""}`,
          userId: "command",
          messageId: `cmd-${Date.now()}`,
        },
        ctx,
      );
      break;

    case "user.action":
      ctx.log?.info(`[${ctx.accountId}] A2UI action ${msg.action} in session ${msg.sessionKey}`);
      // Feed the user's A2UI interaction back to the agent as a message.
      // This lets the agent continue the conversation based on what the
      // user clicked/selected in the interactive UI component.
      {
        const actionParams = msg.params ?? {};
        const kind = actionParams.kind ?? msg.action ?? "action";
        const value = actionParams.value ?? actionParams.selected ?? "";
        const label = actionParams.label ?? value;
        const actionText = `[Action: kind=${kind}] User selected: "${label}"`;
        await handleCloudMessage(
          {
            type: "user.message",
            sessionKey: msg.sessionKey,
            text: actionText,
            userId: (actionParams.userId as string) ?? "action",
            messageId: `action-${Date.now()}`,
          },
          ctx,
        );
      }
      break;

    case "user.media":
      ctx.log?.info(`[${ctx.accountId}] Media from user in session ${msg.sessionKey}: ${msg.mediaUrl}`);
      // Handle as a user.message with mediaUrl so the agent can process the image
      await handleCloudMessage(
        {
          type: "user.message",
          sessionKey: msg.sessionKey,
          text: "",
          userId: msg.userId,
          messageId: `media-${Date.now()}`,
          mediaUrl: msg.mediaUrl,
        },
        ctx,
      );
      break;

    case "config.request":
      ctx.log?.info(`[${ctx.accountId}] Config request: ${msg.method}`);
      break;

    // ---- Task management messages from BotsChat cloud ----

    case "task.schedule":
      ctx.log?.info(`[${ctx.accountId}] Schedule task: cronJobId=${msg.cronJobId} schedule=${msg.schedule}`);
      await handleTaskSchedule(msg, ctx);
      break;

    case "task.delete":
      ctx.log?.info(`[${ctx.accountId}] Delete task: cronJobId=${msg.cronJobId}`);
      await handleTaskDelete(msg, ctx);
      break;

    case "task.run":
      ctx.log?.info(`[${ctx.accountId}] Run task now: cronJobId=${msg.cronJobId} agentId=${msg.agentId}`);
      await handleTaskRun(msg, ctx);
      break;

    case "task.scan.request":
      ctx.log?.info(`[${ctx.accountId}] Task scan requested by cloud`);
      await handleTaskScanRequest(ctx);
      break;

    case "models.request":
      ctx.log?.info(`[${ctx.accountId}] Models list requested by cloud`);
      await handleModelsRequest(ctx);
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Task scheduling — configure CronJobs in OpenClaw via runtime
// ---------------------------------------------------------------------------

/**
 * Convert a human-readable schedule string to OpenClaw's schedule object format.
 * "every 30m" → { kind: "every", everyMs: 1800000 }
 * "every 2h"  → { kind: "every", everyMs: 7200000 }
 * "every 10s" → { kind: "every", everyMs: 10000 }
 * "at 09:00"  → { kind: "at", at: "09:00" }
 */
function parseScheduleToOpenClaw(schedule: string): { kind: string; everyMs?: number; at?: string } | null {
  if (!schedule) return null;

  // Interval: "every {N}{s|m|h}"
  const everyMatch = schedule.match(/^every\s+(\d+(?:\.\d+)?)\s*(s|m|h)$/i);
  if (everyMatch) {
    const value = parseFloat(everyMatch[1]);
    const unit = everyMatch[2].toLowerCase();
    let everyMs: number;
    if (unit === "s") everyMs = value * 1000;
    else if (unit === "m") everyMs = value * 60000;
    else everyMs = value * 3600000; // h
    return { kind: "every", everyMs };
  }

  // Daily: "at HH:MM"
  const atMatch = schedule.match(/^at\s+(\d{1,2}:\d{2})$/i);
  if (atMatch) {
    return { kind: "at", at: atMatch[1] };
  }

  return null;
}

/**
 * Run `openclaw cron edit` to hot-update the CronService.
 * This uses the gateway's RPC (via CLI) so the in-memory scheduler is updated
 * immediately — no gateway restart needed.
 */
async function openclawCronEdit(
  cronJobId: string,
  args: string[],
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
): Promise<{ ok: boolean; error?: string }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const fullArgs = ["cron", "edit", cronJobId, ...args];
  log?.info(`Running: openclaw ${fullArgs.join(" ")}`);

  try {
    const { stdout, stderr } = await execFileAsync("openclaw", fullArgs, {
      timeout: 15_000,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    });
    if (stderr?.trim()) log?.warn(`openclaw cron edit stderr: ${stderr.trim()}`);
    if (stdout?.trim()) log?.info(`openclaw cron edit: ${stdout.trim()}`);
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log?.error(`openclaw cron edit failed: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Run `openclaw cron add` to create a new cron job.
 * Returns the OpenClaw-generated job ID.
 */
async function openclawCronAdd(
  msg: { name?: string; agentId: string; schedule: string; instructions: string; enabled: boolean; model?: string },
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
): Promise<{ ok: boolean; cronJobId?: string; error?: string }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const args: string[] = ["cron", "add"];

  // Name (required by openclaw cron add)
  args.push("--name", msg.name || "BotsChat Task");

  // Schedule
  const s = (msg.schedule || "").trim();
  if (/^at\s+/i.test(s)) {
    args.push("--at", s.replace(/^at\s+/i, ""));
  } else if (s) {
    args.push("--every", s.replace(/^every\s+/i, ""));
  }

  // Payload
  args.push("--message", msg.instructions || "Run your scheduled task.");
  args.push("--session", "isolated");
  if (msg.agentId) args.push("--agent", msg.agentId);
  if (msg.model) args.push("--model", msg.model);
  if (!msg.enabled) args.push("--disabled");
  args.push("--json");

  log?.info(`Running: openclaw ${args.join(" ")}`);

  try {
    const { stdout } = await execFileAsync("openclaw", args, {
      timeout: 15_000,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    });
    // Parse the JSON output to get the generated ID.
    // stdout may contain Config warnings before the JSON — extract
    // the last {...} block.
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { ok: false, error: `openclaw cron add: no JSON in output: ${stdout.slice(0, 200)}` };
    }
    const result = JSON.parse(jsonMatch[0]);
    const cronJobId = result.id;
    if (!cronJobId) {
      return { ok: false, error: "openclaw cron add returned no id" };
    }
    return { ok: true, cronJobId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log?.error(`openclaw cron add failed: ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Check if a cron job exists in OpenClaw by reading jobs.json.
 */
async function cronJobExists(cronJobId: string): Promise<boolean> {
  try {
    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");
    const cronFile = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
    if (!fs.existsSync(cronFile)) return false;
    const data = JSON.parse(fs.readFileSync(cronFile, "utf-8"));
    return Array.isArray(data.jobs) && data.jobs.some((j: { id: string }) => j.id === cronJobId);
  } catch {
    return false;
  }
}

async function handleTaskSchedule(
  msg: { taskId?: string; name?: string; cronJobId: string; agentId: string; schedule: string; instructions: string; enabled: boolean; model?: string },
  ctx: {
    accountId: string;
    log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  },
): Promise<void> {
  const client = getCloudClient(ctx.accountId);
  try {
    const exists = msg.cronJobId ? await cronJobExists(msg.cronJobId) : false;

    if (exists) {
      // Update existing job via `openclaw cron edit` (hot-updates CronService)
      const args: string[] = [];
      if (msg.schedule) {
        const s = msg.schedule.trim();
        if (/^at\s+/i.test(s)) {
          args.push("--at", s.replace(/^at\s+/i, ""));
        } else {
          args.push("--every", s.replace(/^every\s+/i, ""));
        }
      }
      // Always send --message to ensure payload.kind="agentTurn" is set
      // (required for isolated session jobs). If no new instructions, read
      // the existing ones from jobs.json.
      const messageText = msg.instructions || (await readCronJobConfig(msg.cronJobId)).instructions || "Run your scheduled task.";
      args.push("--message", messageText);
      if (msg.model) args.push("--model", msg.model);
      if (msg.enabled) args.push("--enable");
      else args.push("--disable");

      const result = await openclawCronEdit(msg.cronJobId, args, ctx.log);
      if (!result.ok) {
        client?.send({ type: "task.schedule.ack", cronJobId: msg.cronJobId, taskId: msg.taskId, ok: false, error: result.error });
        return;
      }
      ctx.log?.info(`[${ctx.accountId}] Updated cron job ${msg.cronJobId}: ${msg.schedule}`);
      client?.send({ type: "task.schedule.ack", cronJobId: msg.cronJobId, taskId: msg.taskId, ok: true });
    } else {
      // New job: use `openclaw cron add --json` (hot-adds to CronService)
      ctx.log?.info(`[${ctx.accountId}] Creating new cron job via openclaw cron add`);
      const addResult = await openclawCronAdd(msg, ctx.log);
      if (!addResult.ok) {
        client?.send({ type: "task.schedule.ack", cronJobId: msg.cronJobId, taskId: msg.taskId, ok: false, error: addResult.error });
        return;
      }
      // Return the OpenClaw-generated ID + taskId so DO can update D1
      ctx.log?.info(`[${ctx.accountId}] Created cron job ${addResult.cronJobId}: ${msg.schedule}`);
      client?.send({ type: "task.schedule.ack", cronJobId: addResult.cronJobId!, taskId: msg.taskId, ok: true });
    }
  } catch (err) {
    ctx.log?.error(`[${ctx.accountId}] Failed to schedule task: ${err}`);
    client?.send({ type: "task.schedule.ack", cronJobId: msg.cronJobId, taskId: msg.taskId, ok: false, error: String(err) });
  }
}

async function handleTaskDelete(
  msg: { cronJobId: string },
  ctx: {
    accountId: string;
    log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  },
): Promise<void> {
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    ctx.log?.info(`[${ctx.accountId}] Removing cron job ${msg.cronJobId} via openclaw cron rm`);
    await execFileAsync("openclaw", ["cron", "rm", msg.cronJobId], {
      timeout: 15_000,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    });
    ctx.log?.info(`[${ctx.accountId}] Removed cron job ${msg.cronJobId}`);
  } catch (err) {
    ctx.log?.error(`[${ctx.accountId}] Failed to delete task: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// task.run — execute a cron job immediately on demand
// ---------------------------------------------------------------------------

/**
 * Read instructions and model for a cron job from OpenClaw's jobs.json (the single source of truth).
 */
async function readCronJobConfig(cronJobId: string): Promise<{ instructions: string; model?: string }> {
  try {
    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");
    const cronFile = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
    if (fs.existsSync(cronFile)) {
      const data = JSON.parse(fs.readFileSync(cronFile, "utf-8"));
      const job = (data.jobs ?? []).find((j: { id: string }) => j.id === cronJobId);
      if (job) {
        let instructions = "";
        if (typeof job.payload === "string") {
          instructions = job.payload;
        } else if (job.payload && typeof job.payload === "object") {
          instructions = job.payload.message ?? job.payload.text ?? job.payload.prompt ?? "";
        }
        return { instructions, model: job.model };
      }
    }
  } catch { /* ignore */ }
  return { instructions: "" };
}

async function handleTaskRun(
  msg: { cronJobId: string; agentId: string; instructions?: string; model?: string },
  ctx: {
    cfg: unknown;
    accountId: string;
    runtime: unknown;
    log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  },
): Promise<void> {
  const client = getCloudClient(ctx.accountId);
  if (!client?.connected) {
    ctx.log?.error(`[${ctx.accountId}] Cannot run task — not connected`);
    return;
  }

  const now = Date.now();
  const jobId = `job_run_${msg.cronJobId}_${now}`;
  const agentId = msg.agentId || "main";
  // Use a unique sessionKey per run so each cron execution starts with a
  // fresh context.  Previously all runs shared a single session, which
  // caused the context to grow unboundedly (browser screenshots, tool
  // results, etc.) until the model provider rejected the request body
  // (HTTP 422 "Unsupported request body").
  const sessionKey = `agent:${agentId}:cron:${msg.cronJobId}:run:${now}`;
  const startedAt = Math.floor(now / 1000);

  // Immediately send "running" status
  client.send({
    type: "job.update",
    cronJobId: msg.cronJobId,
    jobId,
    sessionKey,
    status: "running",
    startedAt,
  });

  ctx.log?.info(`[${ctx.accountId}] Task ${msg.cronJobId} started (jobId=${jobId})`);

  let summary = "";
  let status: "ok" | "error" = "ok";

  try {
    const runtime = getBotsChatRuntime();

    // First try: use runtime.cron.runJobNow if available
    if (runtime.cron?.runJobNow) {
      ctx.log?.info(`[${ctx.accountId}] Using runtime.cron.runJobNow`);
      await runtime.cron.runJobNow(msg.cronJobId);
      // Read the output from session file
      summary = await readLastSessionOutput(agentId, msg.cronJobId, ctx);
    } else if (runtime.cron?.triggerJob) {
      ctx.log?.info(`[${ctx.accountId}] Using runtime.cron.triggerJob`);
      await runtime.cron.triggerJob(msg.cronJobId);
      summary = await readLastSessionOutput(agentId, msg.cronJobId, ctx);
    } else {
      // Fallback: dispatch the instructions as a user message through the agent pipeline
      ctx.log?.info(`[${ctx.accountId}] Fallback: dispatching instructions via agent pipeline`);
      // Read instructions from OpenClaw's jobs.json (single source of truth),
      // falling back to msg.instructions for backward compatibility.
      const jobConfig = await readCronJobConfig(msg.cronJobId);
      const instructions = jobConfig.instructions || msg.instructions || "Run your scheduled task now.";

      const cfg = runtime.config?.loadConfig?.() ?? ctx.cfg;
      const msgCtx: Record<string, unknown> = {
        Body: instructions,
        RawBody: instructions,
        CommandBody: instructions,
        BodyForCommands: instructions,
        From: `botschat:cron:${msg.cronJobId}`,
        To: sessionKey,
        SessionKey: sessionKey,
        AccountId: ctx.accountId,
        MessageSid: `cron-run-${Date.now()}`,
        ChatType: "direct",
        Channel: "botschat",
        MessageChannel: "botschat",
        CommandAuthorized: true,
      };

      const finalizedCtx = runtime.channel.reply.finalizeInboundContext(msgCtx);

      // Collect the agent's reply as summary + stream output in real-time
      // We accumulate completed message blocks and current streaming text.
      // The frontend receives the full accumulated text each time and renders
      // each block (separated by \n\n---\n\n) as a stacked message card.
      const completedParts: string[] = [];
      let currentStreamText = "";
      let sendTimer: ReturnType<typeof setTimeout> | null = null;
      const THROTTLE_MS = 200;

      const getFullText = (): string => {
        const parts = [...completedParts];
        if (currentStreamText) parts.push(currentStreamText);
        return parts.join("\n\n---\n\n");
      };

      const sendOutput = () => {
        if (!client?.connected) return;
        client.send({
          type: "job.output",
          cronJobId: msg.cronJobId,
          jobId,
          text: getFullText(),
        });
      };

      const throttledSendOutput = () => {
        if (sendTimer) return; // already scheduled
        sendTimer = setTimeout(() => {
          sendTimer = null;
          sendOutput();
        }, THROTTLE_MS);
      };

      const deliver = async (payload: { text?: string; mediaUrl?: string }) => {
        if (payload.text) {
          completedParts.push(payload.text);
          currentStreamText = "";
          // Flush immediately on completed message
          if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
          sendOutput();
        }
      };

      // Stream partial output in real-time via job.output (throttled)
      const onPartialReply = (payload: { text?: string }) => {
        if (!client?.connected || !payload.text) return;
        currentStreamText = payload.text;
        throttledSendOutput();
      };

      const { dispatcher, replyOptions, markDispatchIdle } =
        runtime.channel.reply.createReplyDispatcherWithTyping({
          deliver: async (payload: unknown) => {
            const p = payload as { text?: string; mediaUrl?: string };
            await deliver(p);
          },
          onTypingStart: () => {},
          onTypingStop: () => {},
        });

      await runtime.channel.reply.dispatchReplyFromConfig({
        ctx: finalizedCtx,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          onPartialReply,
          allowPartialStream: true,
        },
      });

      markDispatchIdle();
      // Flush any pending throttled output
      if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
      summary = completedParts.join("\n\n---\n\n");
    }
  } catch (err) {
    status = "error";
    summary = `Task failed: ${String(err)}`;
    ctx.log?.error(`[${ctx.accountId}] Task ${msg.cronJobId} failed: ${err}`);
  }

  const finishedAt = Math.floor(Date.now() / 1000);
  const durationMs = (finishedAt - startedAt) * 1000;

  // Send final status
  client.send({
    type: "job.update",
    cronJobId: msg.cronJobId,
    jobId,
    sessionKey,
    status,
    summary,
    startedAt,
    finishedAt,
    durationMs,
  });

  ctx.log?.info(`[${ctx.accountId}] Task ${msg.cronJobId} finished: status=${status} duration=${durationMs}ms`);
}

// ---------------------------------------------------------------------------
// Cron run log types & 3-layer data retrieval
// ---------------------------------------------------------------------------

type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action: string;
  status?: string;
  error?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
};

/**
 * Layer 1 — Read cron run log entries directly from
 * ~/.openclaw/cron/runs/{jobId}.jsonl (most recent last).
 */
async function readCronRunLog(
  jobId: string,
  limit = 5,
): Promise<CronRunLogEntry[]> {
  try {
    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");
    const logFile = path.join(os.homedir(), ".openclaw", "cron", "runs", `${jobId}.jsonl`);
    if (!fs.existsSync(logFile)) return [];

    const stat = fs.statSync(logFile);
    const readSize = Math.min(stat.size, 32768);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(logFile, "r");
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const tail = buf.toString("utf-8");
    const lines = tail.split("\n").filter(Boolean);
    const entries: CronRunLogEntry[] = [];

    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj?.action === "finished" && obj.jobId === jobId) {
          entries.push(obj as CronRunLogEntry);
        }
      } catch { /* skip malformed line */ }
    }

    return entries.reverse(); // chronological order
  } catch {
    return [];
  }
}

/**
 * Layer 2 — CLI fallback: `openclaw cron runs --id <jobId> --limit <n>`.
 * Uses the Gateway RPC under the hood, returns the same data as Layer 1.
 */
async function readCronRunLogViaCli(
  jobId: string,
  limit = 5,
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
): Promise<CronRunLogEntry[]> {
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      "openclaw",
      ["cron", "runs", "--id", jobId, "--limit", String(limit)],
      {
        timeout: 15_000,
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
      },
    );
    const result = JSON.parse(stdout.trim());
    return (result?.entries ?? []) as CronRunLogEntry[];
  } catch (err) {
    log?.warn?.(`CLI openclaw cron runs failed for ${jobId}: ${err}`);
    return [];
  }
}

/**
 * Layer 3 — Read assistant output from a session JSONL file by sessionId.
 * Returns the last assistant text and model used.
 */
async function readSessionOutputById(
  agentId: string,
  sessionId: string,
): Promise<{ text: string; model?: string }> {
  try {
    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");
    const jsonlFile = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions", `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonlFile)) return { text: "" };

    const stat = fs.statSync(jsonlFile);
    const readSize = Math.min(stat.size, 16384);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(jsonlFile, "r");
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const tail = buf.toString("utf-8");
    const lines = tail.split("\n").filter(Boolean);

    let text = "";
    let model: string | undefined;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry?.message?.role === "assistant") {
          if (!model && entry.message.model) {
            model = entry.message.model;
          }
          if (!text && Array.isArray(entry.message.content)) {
            const textPart = entry.message.content.find(
              (c: { type: string; text?: string }) => c.type === "text" && c.text,
            );
            if (textPart) text = textPart.text;
          }
          if (text && model) break;
        }
      } catch { /* skip */ }
    }

    return { text, model };
  } catch {
    return { text: "" };
  }
}

/**
 * Read the last cron output using 3-layer strategy:
 *   1. Run log JSONL  (~/.openclaw/cron/runs/{jobId}.jsonl) → summary
 *   2. CLI fallback    (openclaw cron runs) → same data
 *   3. Session JSONL   (~/.openclaw/agents/.../sessions/{sessionId}.jsonl) → full output
 */
async function readLastSessionOutput(
  agentId: string,
  cronJobId: string,
  ctx: { log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } },
): Promise<string> {
  // Layer 1: read run log directly
  let entries = await readCronRunLog(cronJobId, 1);

  // Layer 2: CLI fallback
  if (entries.length === 0) {
    ctx.log?.info?.(`Run log empty for ${cronJobId}, trying CLI fallback`);
    entries = await readCronRunLogViaCli(cronJobId, 1, ctx.log);
  }

  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : undefined;

  // If run log has a summary, use it
  if (lastEntry?.summary) {
    return lastEntry.summary;
  }

  // Layer 3: read session JSONL for full output
  const sessionId = lastEntry?.sessionId;
  if (sessionId) {
    const result = await readSessionOutputById(agentId, sessionId);
    if (result.text) return result.text;
  }

  // Final fallback: try sessions.json lookup (original approach)
  try {
    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");

    const sessionsFile = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions", "sessions.json");
    if (!fs.existsSync(sessionsFile)) return "";

    const sessData = JSON.parse(fs.readFileSync(sessionsFile, "utf-8")) as Record<string, { sessionId?: string }>;
    const sessKey = `agent:${agentId}:cron:${cronJobId}`;
    const sessEntry = sessData[sessKey];
    if (!sessEntry?.sessionId) return "";

    const result = await readSessionOutputById(agentId, sessEntry.sessionId);
    return result.text;
  } catch (err) {
    ctx.log?.warn?.(`Failed to read session output: ${err}`);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Startup task scanning — scan existing CronJobs and report to cloud
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Models listing — read configured providers from OpenClaw config.
// Extracts unique provider names from model keys (provider/model format)
// so the dropdown matches what `/models` returns.
// ---------------------------------------------------------------------------

async function handleModelsRequest(
  ctx: {
    accountId: string;
    log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  },
): Promise<void> {
  const client = getCloudClient(ctx.accountId);
  if (!client?.connected) return;

  try {
    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");
    const configFile = path.join(os.homedir(), ".openclaw", "openclaw.json");

    // Collect all model keys, then group by provider
    const allKeys: string[] = [];

    const addKey = (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed) allKeys.push(trimmed);
    };

    if (fs.existsSync(configFile)) {
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf-8"));

      // 1. Primary default model
      const primary = cfg?.agents?.defaults?.model?.primary;
      if (typeof primary === "string") addKey(primary);

      // 2. Fallback models
      const fallbacks = cfg?.agents?.defaults?.model?.fallbacks;
      if (Array.isArray(fallbacks)) {
        for (const fb of fallbacks) {
          if (typeof fb === "string") addKey(fb);
        }
      }

      // 3. Configured models (allowlist)
      const configuredModels = cfg?.agents?.defaults?.models;
      if (configuredModels && typeof configuredModels === "object") {
        for (const key of Object.keys(configuredModels)) {
          addKey(key);
        }
      }

      // 4. Image model + fallbacks
      const imagePrimary = cfg?.agents?.defaults?.imageModel?.primary;
      if (typeof imagePrimary === "string") addKey(imagePrimary);
      const imageFallbacks = cfg?.agents?.defaults?.imageModel?.fallbacks;
      if (Array.isArray(imageFallbacks)) {
        for (const fb of imageFallbacks) {
          if (typeof fb === "string") addKey(fb);
        }
      }
    }

    // Deduplicate full model keys (provider/model)
    const seen = new Set<string>();
    const models: Array<{ id: string; name: string; provider: string }> = [];
    for (const key of allKeys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const slash = key.indexOf("/");
      const provider = slash > 0 ? key.slice(0, slash) : key;
      const model = slash > 0 ? key.slice(slash + 1) : key;
      models.push({ id: key, name: model, provider });
    }

    ctx.log?.info(`[${ctx.accountId}] Models scan: found ${models.length} providers`);
    client.send({ type: "models.list", models });
  } catch (err) {
    ctx.log?.error(`[${ctx.accountId}] Failed to read models: ${err}`);
    client.send({ type: "models.list", models: [] });
  }
}

// ---------------------------------------------------------------------------
// Startup task scanning — scan existing CronJobs and report to cloud
// ---------------------------------------------------------------------------

async function handleTaskScanRequest(
  ctx: {
    accountId: string;
    log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  },
): Promise<void> {
  const client = getCloudClient(ctx.accountId);
  if (!client?.connected) return;

  try {
    const scannedTasks: Array<{
      cronJobId: string;
      name: string;
      schedule: string;
      agentId: string;
      enabled: boolean;
      instructions: string;
      model?: string;
      lastRun?: { status: string; ts: number; summary?: string; durationMs?: number };
    }> = [];

    // Read cron jobs directly from ~/.openclaw/cron/jobs.json
    // because runtime.cron is not exposed to plugins.
    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");
    const cronFile = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");

    if (fs.existsSync(cronFile)) {
      const raw = fs.readFileSync(cronFile, "utf-8");
      const data = JSON.parse(raw) as {
        jobs?: Array<{
          id: string;
          name?: string;
          agentId?: string;
          enabled?: boolean;
          model?: string;
          payload?: unknown;
          schedule?: { kind: string; everyMs?: number; anchorMs?: number; at?: string };
          state?: { lastRunAtMs?: number; lastStatus?: string; lastDurationMs?: number };
        }>;
      };

      if (Array.isArray(data.jobs)) {
        for (const job of data.jobs) {
          // Convert schedule object to a human-readable string
          let scheduleStr = "";
          if (job.schedule) {
            if (job.schedule.kind === "every" && job.schedule.everyMs) {
              const ms = job.schedule.everyMs;
              if (ms >= 3600000) scheduleStr = `every ${ms / 3600000}h`;
              else if (ms >= 60000) scheduleStr = `every ${ms / 60000}m`;
              else scheduleStr = `every ${ms / 1000}s`;
            } else if (job.schedule.kind === "at" && job.schedule.at) {
              scheduleStr = `at ${job.schedule.at}`;
            }
          }

          let lastRun: { status: string; ts: number; summary?: string; durationMs?: number } | undefined;
          // Prefer model from jobs.json (explicitly set by user), fallback to session detection
          let detectedModel = job.model ?? "";
          if (job.state?.lastRunAtMs) {
            // 3-layer strategy to get last run output:
            //   Layer 1: run log JSONL → summary
            //   Layer 2: CLI fallback → same data
            //   Layer 3: session JSONL → full assistant output
            let lastOutput = "";
            const agentId = job.agentId ?? "main";

            // Layer 1: read run log directly
            let runEntries = await readCronRunLog(job.id, 1);

            // Layer 2: CLI fallback if run log file not found
            if (runEntries.length === 0) {
              runEntries = await readCronRunLogViaCli(job.id, 1, ctx.log);
            }

            const lastRunEntry = runEntries.length > 0 ? runEntries[runEntries.length - 1] : undefined;

            if (lastRunEntry?.summary) {
              lastOutput = lastRunEntry.summary;
            }

            // Layer 3: if summary is empty, read session JSONL for full output
            if (!lastOutput) {
              const sessionId = lastRunEntry?.sessionId;
              if (sessionId) {
                // Use sessionId from run log — no need to look up sessions.json
                const sessResult = await readSessionOutputById(agentId, sessionId);
                if (sessResult.text) lastOutput = sessResult.text;
                if (!detectedModel && sessResult.model) detectedModel = sessResult.model;
              }
            }

            // Use durationMs from run log if available (more accurate)
            const durationMs = lastRunEntry?.durationMs ?? job.state.lastDurationMs;
            const status = lastRunEntry?.status ?? job.state.lastStatus ?? "ok";
            const ts = lastRunEntry?.runAtMs
              ? Math.floor(lastRunEntry.runAtMs / 1000)
              : Math.floor(job.state.lastRunAtMs / 1000);

            lastRun = {
              status,
              ts,
              summary: lastOutput || undefined,
              durationMs,
            };
          }

          // Extract instructions/prompt from payload
          let instructions = "";
          if (job.payload) {
            if (typeof job.payload === "string") {
              instructions = job.payload;
            } else if (typeof job.payload === "object" && job.payload !== null) {
              const p = job.payload as Record<string, unknown>;
              instructions = (p.message as string) ?? (p.text as string) ?? (p.prompt as string) ?? "";
            }
          }

          // Also try to get model from agent config if not found in session
          if (!detectedModel) {
            try {
              const agentConfigFile = path.join(os.homedir(), ".openclaw", "agents", job.agentId ?? "main", "config.json");
              if (fs.existsSync(agentConfigFile)) {
                const agentCfg = JSON.parse(fs.readFileSync(agentConfigFile, "utf-8"));
                if (agentCfg?.model) detectedModel = agentCfg.model;
              }
            } catch { /* ignore */ }
          }

          scannedTasks.push({
            cronJobId: job.id,
            name: job.name ?? job.id,
            schedule: scheduleStr,
            agentId: job.agentId ?? "",
            enabled: job.enabled !== false,
            instructions,
            model: detectedModel || undefined,
            lastRun,
          });
        }
      }

      ctx.log?.info(`[${ctx.accountId}] Task scan: read ${scannedTasks.length} jobs from ${cronFile}`);
    } else {
      ctx.log?.info(`[${ctx.accountId}] Task scan: cron file not found at ${cronFile}`);
    }

    ctx.log?.info(`[${ctx.accountId}] Task scan complete: found ${scannedTasks.length} background tasks`);
    client.send({ type: "task.scan.result", tasks: scannedTasks });
  } catch (err) {
    ctx.log?.error(`[${ctx.accountId}] Task scan failed: ${err}`);
    // Send empty result on error
    client.send({ type: "task.scan.result", tasks: [] });
  }
}


