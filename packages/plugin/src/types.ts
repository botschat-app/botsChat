// ---------------------------------------------------------------------------
// BotsChat channel configuration stored in the user's openclaw.json
// under channels.botschat (or channels.botschat.accounts.<id>)
// ---------------------------------------------------------------------------

/** Per-account config persisted in openclaw.json */
export type BotsChatAccountConfig = {
  enabled?: boolean;
  name?: string;
  cloudUrl?: string; // e.g. "console.botschat.app"
  pairingToken?: string; // e.g. "bc_pat_xxxxxxxx"
};

/** Resolved account ready for runtime use */
export type ResolvedBotsChatAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  cloudUrl: string;
  pairingToken: string;
  config: BotsChatAccountConfig;
};

/** Root config shape (only the slice we care about) */
export type BotsChatChannelConfig = {
  channels?: {
    botschat?: BotsChatAccountConfig & {
      accounts?: Record<string, BotsChatAccountConfig>;
    };
  };
};

// ---------------------------------------------------------------------------
// Cloud message protocol — messages exchanged over the WSS between
// the OpenClaw plugin and the BotsChat cloud (ConnectionDO)
// ---------------------------------------------------------------------------

/** Plugin → Cloud (outbound, agent responses) */
export type CloudOutbound =
  | { type: "auth"; token: string; agents?: string[]; model?: string }
  | {
      type: "agent.text";
      sessionKey: string;
      text: string;
      replyToId?: string;
      threadId?: string;
    }
  | {
      type: "agent.media";
      sessionKey: string;
      mediaUrl: string;
      caption?: string;
      replyToId?: string;
      threadId?: string;
    }
  | { type: "agent.stream.start"; sessionKey: string; runId: string }
  | {
      type: "agent.stream.chunk";
      sessionKey: string;
      runId: string;
      text: string;
    }
  | { type: "agent.stream.end"; sessionKey: string; runId: string }
  | {
      type: "agent.a2ui";
      sessionKey: string;
      jsonl: string;
      replyToId?: string;
      threadId?: string;
    }
  | { type: "status"; connected: boolean; agents: string[]; model?: string }
  | { type: "pong" }
  // Task scan result — plugin reports existing cron jobs after connecting
  | {
      type: "task.scan.result";
      tasks: Array<{
        cronJobId: string;
        name: string;
        schedule: string;
        agentId: string;
        enabled: boolean;
        instructions: string;
        model?: string;
        lastRun?: { status: string; ts: number; summary?: string };
      }>;
    }
  // Job update — plugin reports a cron job execution result
  | {
      type: "job.update";
      cronJobId: string;
      jobId: string;
      sessionKey: string;
      status: "running" | "ok" | "error" | "skipped";
      summary?: string;
      startedAt: number;
      finishedAt?: number;
      durationMs?: number;
    }
  // Job output — streaming text output while a job is running
  | {
      type: "job.output";
      cronJobId: string;
      jobId: string;
      text: string;
    }
  // Task schedule ack — plugin confirms schedule was applied
  // cronJobId may differ from the request when a new job was created by OpenClaw
  | { type: "task.schedule.ack"; cronJobId: string; taskId?: string; ok: boolean; error?: string }
  // Models list — plugin reports available providers/models
  | { type: "models.list"; models: Array<{ id: string; name: string; provider: string }> }
  // Model changed — plugin notifies that /model command switched the active model
  | { type: "model.changed"; model: string; sessionKey: string }
  // Default model updated — plugin applied BotsChat default model to OpenClaw config
  | { type: "defaultModel.updated"; model: string };

/** Cloud → Plugin (inbound, user messages) */
export type CloudInbound =
  | { type: "auth.ok" }
  | { type: "auth.fail"; reason: string }
  | {
      type: "user.message";
      sessionKey: string;
      text: string;
      userId: string;
      messageId: string;
      mediaUrl?: string;
    }
  | {
      type: "user.media";
      sessionKey: string;
      mediaUrl: string;
      userId: string;
    }
  | {
      type: "user.action";
      sessionKey: string;
      action: string;
      params: Record<string, unknown>;
    }
  | {
      type: "user.command";
      sessionKey: string;
      command: string;
      args?: string;
    }
  | { type: "config.request"; method: string; params: unknown }
  | { type: "ping" }
  // Task schedule — cloud tells plugin to configure a CronJob
  // taskId is the BotsChat task record ID (for updating D1 after creation)
  // cronJobId may be empty for new tasks (plugin will create via openclaw cron add)
  | {
      type: "task.schedule";
      taskId?: string;
      name?: string;
      cronJobId: string;
      agentId: string;
      schedule: string;
      instructions: string;
      enabled: boolean;
      model?: string;
    }
  // Task delete — cloud tells plugin to remove a CronJob
  | { type: "task.delete"; cronJobId: string }
  // Task run — cloud tells plugin to execute a cron job immediately
  | {
      type: "task.run";
      cronJobId: string;
      agentId: string;
      instructions: string;
      model?: string;
    }
  // Task scan request — cloud asks plugin to scan existing cron jobs
  | { type: "task.scan.request" }
  // Models request — cloud asks plugin for available models/providers
  | { type: "models.request" }
  // Default model — cloud pushes user's default model so plugin applies it in OpenClaw config
  | { type: "settings.defaultModel"; defaultModel: string };

export type CloudMessage = CloudOutbound | CloudInbound;
