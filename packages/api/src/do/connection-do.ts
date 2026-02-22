import type { Env } from "../env.js";
import { verifyToken, getJwtSecret, signMediaUrl } from "../utils/auth.js";
import { getFcmAccessToken, sendPushNotification } from "../utils/fcm.js";
import { sendApnsNotification, type ApnsConfig } from "../utils/apns.js";
import { generateId as generateIdUtil } from "../utils/id.js";
import { randomUUID } from "../utils/uuid.js";

/** Presence info stored in browser WebSocket attachments (survives DO hibernation). */
interface BrowserAttachment {
  authenticated: boolean;
  tag: string;
  foreground: boolean;
  sessionKey: string | null;
  /** Timestamp (ms) when the session last went to background. */
  backgroundAt: number | null;
}

/** Grace period constants for push notification suppression. */
const BG_GRACE_MS = 15_000;   // 15 s after going background
const DC_GRACE_MS = 30_000;   // 30 s after WebSocket disconnect

/**
 * ConnectionDO — one Durable Object instance per BotsChat user.
 *
 * Responsibilities:
 * - Hold the persistent WSS from the user's OpenClaw instance
 * - Hold WebSocket(s) from the user's browser sessions
 * - Bidirectionally relay messages between OpenClaw and browsers
 * - Use WebSocket Hibernation API so idle users cost zero compute
 *
 * Connection tagging (via serializeAttachment / deserializeAttachment):
 * - "agent:<agentId>" = WebSocket from an agent plugin (v2, per-agent)
 * - "openclaw" = legacy WebSocket from the OpenClaw plugin (backward compat)
 * - "browser:<sessionId>" = a browser client WebSocket
 */
export class ConnectionDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  /** Global default model from OpenClaw config (gateway primary model) */
  private defaultModel: string | null = null;
  /** Cached models list from OpenClaw plugin */
  private cachedModels: Array<{ id: string; name: string; provider: string }> = [];

  /** Pending resolve for a real-time task.scan.request → task.scan.result round-trip. */
  private pendingScanResolve: ((tasks: Array<Record<string, unknown>>) => void) | null = null;

  /**
   * Recently disconnected browser sessions — provides a grace period so that
   * brief network blips don't immediately trigger push notifications.
   * In-memory only; if the DO hibernates, the grace period has expired anyway.
   */
  private recentDisconnects = new Map<string, number>();

  /** Timestamp of last accepted OpenClaw WebSocket (in-memory, no storage write). */
  private lastOpenClawAcceptedAt = 0;

  /** Pending agent.request delegations — maps requestId to originator info. */
  private pendingRequests = new Map<string, { fromAgentId: string; sessionKey: string; depth: number; createdAt: number }>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** Handle incoming HTTP requests (WebSocket upgrades). */
  async fetch(request: Request): Promise<Response> {
    try {
      return await this._fetch(request);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("Exceeded")) {
        console.error("[DO] Storage limit exceeded:", msg);
        return new Response("Storage limit exceeded, retry later", {
          status: 503,
          headers: { "Retry-After": "300" },
        });
      }
      throw err;
    }
  }

  private async _fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Route: /gateway/:accountId — OpenClaw plugin connects here
    if (url.pathname.startsWith("/gateway/")) {
      const userId = url.pathname.split("/gateway/")[1]?.split("?")[0];
      if (userId) {
        const stored = await this.state.storage.get<string>("userId");
        if (stored !== userId) {
          await this.state.storage.put("userId", userId);
        }
      }
      const preVerified = url.searchParams.get("verified") === "1";
      const agentId = url.searchParams.get("agentId");
      return this.handleOpenClawConnect(request, preVerified, agentId);
    }

    // Route: /client/:sessionId — Browser client connects here
    if (url.pathname.startsWith("/client/")) {
      return this.handleBrowserConnect(request);
    }

    // Route: /messages — Fetch message history (REST)
    if (url.pathname === "/messages" && request.method === "GET") {
      return this.handleGetMessages(url);
    }

    // Route: /models — Available models (REST)
    if (url.pathname === "/models") {
      await this.ensureCachedModels();
      console.log(`[DO] GET /models — returning ${this.cachedModels.length} models`);
      return Response.json({ models: this.cachedModels });
    }

    // Route: /scan-data — Cached OpenClaw scan data (schedule/instructions/model)
    if (url.pathname === "/scan-data") {
      return this.handleGetScanData();
    }

    // Route: /status — Connection status (REST)
    if (url.pathname === "/status") {
      return this.handleStatus();
    }

    // Route: /send — Send a message to OpenClaw (REST, used by API worker)
    if (url.pathname === "/send" && request.method === "POST") {
      return this.handleSendToOpenClaw(request);
    }

    return new Response("Not found", { status: 404 });
  }

  // ---- WebSocket Hibernation API handlers ----

  /** Called when a WebSocket receives a message (wakes from hibernation). */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const tag = this.getTag(ws);
      const data = typeof message === "string" ? message : new TextDecoder().decode(message);

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }

      if (tag === "openclaw" || tag?.startsWith("agent:")) {
        await this.handleOpenClawMessage(ws, parsed);
      } else if (tag?.startsWith("browser:")) {
        await this.handleBrowserMessage(ws, parsed);
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes("Exceeded")) {
        console.error("[DO] Storage limit exceeded in webSocketMessage:", msg);
        try {
          ws.send(JSON.stringify({ type: "error", message: "Storage limit exceeded, retry later" }));
        } catch { /* socket may already be dead */ }
        return;
      }
      throw err;
    }
  }

  /** Called when a WebSocket is closed. */
  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const tag = this.getTag(ws);
    if (tag === "openclaw" || tag?.startsWith("agent:")) {
      this.broadcastToBrowsers(
        JSON.stringify({ type: "openclaw.disconnected" }),
      );
    }
    // Disconnect grace: remember recently-disconnected browser sessions so
    // push notifications are still suppressed during brief network blips.
    if (tag?.startsWith("browser:")) {
      const att = ws.deserializeAttachment() as BrowserAttachment | null;
      if (att?.foreground) {
        this.recentDisconnects.set(tag, Date.now());
      }
    }
  }

  /** Called when a WebSocket encounters an error. */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const tag = this.getTag(ws);
    console.error(`WebSocket error for ${tag}:`, error);
  }

  // ---- Connection handlers ----

  private handleOpenClawConnect(request: Request, preVerified = false, agentId?: string | null): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const now = Date.now();
    const cooldownMs = 30_000;
    if (now - this.lastOpenClawAcceptedAt < cooldownMs) {
      const retryAfter = Math.ceil((cooldownMs - (now - this.lastOpenClawAcceptedAt)) / 1000);
      return new Response("Too many connections, retry later", {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
      });
    }
    this.lastOpenClawAcceptedAt = now;

    const wsTag = agentId ? "agent:" + agentId : "openclaw";

    // Safety valve: if stale sockets with the same tag accumulated (e.g. from
    // rapid reconnects that authenticated but then lost their edge
    // connection), close them all before accepting a new one.
    const existing = this.state.getWebSockets(wsTag);
    if (existing.length > 3) {
      console.warn(`[DO] Safety valve: ${existing.length} ${wsTag} sockets, closing all`);
      for (const s of existing) {
        try { s.close(4009, "replaced"); } catch { /* dead */ }
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.state.acceptWebSocket(server, [wsTag]);

    // If the API worker already verified the token against D1, mark as
    // pre-verified. The plugin still sends an auth message, which we'll
    // fast-track through without re-validating the token.
    server.serializeAttachment({ authenticated: false, tag: wsTag, agentId: agentId ?? null, preVerified });

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleBrowserConnect(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const sessionId = url.pathname.split("/client/")[1] || randomUUID();

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const tag = `browser:${sessionId}`;
    this.state.acceptWebSocket(server, [tag]);
    const att: BrowserAttachment = {
      authenticated: false,
      tag,
      foreground: false,
      sessionKey: null,
      backgroundAt: null,
    };
    server.serializeAttachment(att);

    // Clear disconnect grace entry — this session is back.
    this.recentDisconnects.delete(tag);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Message routing ----

  private async handleOpenClawMessage(
    ws: WebSocket,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const attachment = ws.deserializeAttachment() as { authenticated: boolean; tag: string; preVerified?: boolean } | null;

    // Handle auth handshake
    if (msg.type === "auth") {
      const token = msg.token as string;
      // If the API worker already validated this token against D1, skip
      // the DO-level check. Otherwise fall back to local validation.
      const isValid = attachment?.preVerified || await this.validatePairingToken(token);

      if (isValid) {
        // Close other sockets with the SAME tag. Use custom code 4009 so
        // well-behaved plugins know they were replaced (not a crash)
        // and should NOT reconnect. The Worker-level rate limit (10s)
        // prevents the resulting close event from flooding the DO.
        const wsTag = attachment?.tag ?? "openclaw";
        const existingSockets = this.state.getWebSockets(wsTag);
        let closedCount = 0;
        for (const oldWs of existingSockets) {
          if (oldWs !== ws) {
            try {
              oldWs.close(4009, "replaced");
              closedCount++;
            } catch { /* already dead */ }
          }
        }

        ws.serializeAttachment({ ...attachment, authenticated: true });
        const userId = await this.state.storage.get<string>("userId");
        console.log(`[DO] auth.ok → userId=${userId}, closed=${closedCount}, total=${existingSockets.length}`);
        ws.send(JSON.stringify({ type: "auth.ok", userId }));
        if (msg.model && msg.model !== this.defaultModel) {
          this.defaultModel = msg.model as string;
          await this.state.storage.put("defaultModel", this.defaultModel);
        }
        // After auth, request task scan + models list from the plugin
        ws.send(JSON.stringify({ type: "task.scan.request" }));
        ws.send(JSON.stringify({ type: "models.request" }));
        // Send notification preview preference to plugin
        const notifyPreview = await this.getNotifyPreviewSetting(userId);
        ws.send(JSON.stringify({ type: "settings.notifyPreview", enabled: notifyPreview }));
        // Notify all browser clients that OpenClaw is now connected
        this.broadcastToBrowsers(
          JSON.stringify({ type: "connection.status", openclawConnected: true, defaultModel: this.defaultModel, models: this.cachedModels }),
        );
      } else {
        ws.send(JSON.stringify({ type: "auth.fail", reason: "Invalid pairing token" }));
        ws.close(4001, "Authentication failed");
      }
      return;
    }

    // Reject unauthenticated messages
    if (!attachment?.authenticated) {
      ws.send(JSON.stringify({ type: "auth.fail", reason: "Not authenticated" }));
      return;
    }

    // Resolve @channelName session keys to real adhoc task session keys
    if (
      (msg.type === "agent.text" || msg.type === "agent.media" || msg.type === "agent.a2ui" ||
       msg.type === "agent.stream.start" || msg.type === "agent.stream.chunk" || msg.type === "agent.stream.end") &&
      typeof msg.sessionKey === "string" && msg.sessionKey.startsWith("@")
    ) {
      msg.sessionKey = await this.resolveChannelSessionKey(msg.sessionKey);
    }

    // Persist agent messages to D1 (skip transient stream events)
    if (msg.type === "agent.text" || msg.type === "agent.media" || msg.type === "agent.a2ui") {
      console.log("[DO] Agent outbound:", JSON.stringify({
        type: msg.type,
        sessionKey: msg.sessionKey,
        threadId: msg.threadId,
        replyToId: msg.replyToId,
        hasMedia: !!msg.mediaUrl,
      }));

      // For agent.media, cache external images to R2 so they remain accessible
      // even after the original URL expires (e.g. DALL-E temporary URLs).
      // Skip caching if the plugin already uploaded E2E-encrypted media.
      let persistedMediaUrl = msg.mediaUrl as string | undefined;
      if (msg.type === "agent.media" && persistedMediaUrl && !msg.mediaEncrypted) {
        const cachedUrl = await this.cacheExternalMedia(persistedMediaUrl);
        if (cachedUrl) {
          persistedMediaUrl = cachedUrl;
          msg.mediaUrl = cachedUrl;
        }
      }

      // Bitmask: bit 0 = text encrypted, bit 1 = media encrypted
      const encryptedBits = (msg.encrypted ? 1 : 0) | (msg.mediaEncrypted ? 2 : 0);

      // Extract agentId from the sending WebSocket's attachment
      const wsAtt = ws.deserializeAttachment() as { agentId?: string } | null;

      await this.persistMessage({
        id: msg.messageId as string | undefined,
        sender: "agent",
        sessionKey: msg.sessionKey as string,
        threadId: (msg.threadId ?? msg.replyToId) as string | undefined,
        text: (msg.text ?? msg.caption ?? "") as string,
        mediaUrl: persistedMediaUrl,
        a2ui: msg.jsonl as string | undefined,
        encrypted: encryptedBits,
        senderAgentId: (msg.agentId as string | undefined) ?? wsAtt?.agentId ?? undefined,
      });
    }

    // model.changed is a per-session event — just log and forward to browsers
    // (forwarding happens at the bottom of this method). DO does NOT track per-session models.
    if (msg.type === "model.changed" && msg.model) {
      console.log(`[DO] Session model changed to: ${msg.model} (sessionKey: ${msg.sessionKey ?? "?"})`);
    }

    // Handle task schedule ack — update D1 with the OpenClaw-generated cronJobId
    if (msg.type === "task.schedule.ack" && msg.ok && msg.taskId && msg.cronJobId) {
      try {
        await this.env.DB.prepare(
          "UPDATE tasks SET provider_job_id = ? WHERE id = ?",
        ).bind(msg.cronJobId, msg.taskId).run();
        console.log(`[DO] Updated task ${msg.taskId} with cronJobId ${msg.cronJobId}`);
      } catch (err) {
        console.error(`[DO] Failed to update task cronJobId: ${err}`);
      }
    }

    // Handle task scan results from plugin — sync to D1 and forward to browsers
    if (msg.type === "task.scan.result") {
      await this.handleTaskScanResult(msg);
    }

    if (msg.type === "models.list") {
      const newModels = (msg.models as Array<{ id: string; name: string; provider: string }>) ?? [];
      const changed = JSON.stringify(newModels) !== JSON.stringify(this.cachedModels);
      this.cachedModels = newModels;
      if (changed) {
        await this.state.storage.put("cachedModels", this.cachedModels);
        console.log(`[DO] Persisted ${this.cachedModels.length} models to storage`);
      }
      this.broadcastToBrowsers(
        JSON.stringify({ type: "connection.status", openclawConnected: true, defaultModel: this.defaultModel, models: this.cachedModels }),
      );
    }

    if (msg.type === "defaultModel.updated" && typeof msg.model === "string") {
      if (msg.model !== this.defaultModel) {
        this.defaultModel = msg.model;
        await this.state.storage.put("defaultModel", this.defaultModel);
      }
      this.broadcastToBrowsers(
        JSON.stringify({ type: "connection.status", openclawConnected: true, defaultModel: this.defaultModel, models: this.cachedModels }),
      );
    }

    // Handle job updates from plugin — persist and forward to browsers
    if (msg.type === "job.update") {
      await this.handleJobUpdate(msg);
    }

    // Handle agent.request — Agent-to-Agent delegation
    if (msg.type === "agent.request") {
      await this.handleAgentRequest(ws, msg);
      return;
    }

    // Handle agent.trace — persist verbose execution traces (lv2/lv3)
    if (msg.type === "agent.trace") {
      await this.handleAgentTrace(msg);
      return;
    }

    // Forward all messages to browser clients (strip notifyPreview — plaintext
    // must not be relayed to browser WebSockets; browsers decrypt locally)
    if (msg.type === "agent.text") {
      console.log(`[DO] Forwarding agent.text to browsers: encrypted=${msg.encrypted}, messageId=${msg.messageId}, textLen=${typeof msg.text === "string" ? msg.text.length : "?"}`);
    }

    const wsAttForReply = ws.deserializeAttachment() as { agentId?: string } | null;

    // Check if this agent.text is a response to a pending agent.request
    if ((msg.type === "agent.text" || msg.type === "agent.stream.end") && msg.requestId) {
      const pending = this.pendingRequests.get(msg.requestId as string);
      if (pending) {
        const originSocket = this.getAgentSocket(pending.fromAgentId);
        if (originSocket) {
          originSocket.send(JSON.stringify({
            type: "agent.response",
            requestId: msg.requestId,
            fromAgentId: (msg.agentId as string) ?? wsAttForReply?.agentId ?? null,
            text: (msg.text ?? "") as string,
            sessionKey: (msg.sessionKey ?? "") as string,
          }));
        }
        this.pendingRequests.delete(msg.requestId as string);
      }
    }

    const { notifyPreview: _stripped, ...msgForBrowser } = msg;
    this.broadcastToBrowsers(JSON.stringify(msgForBrowser));

    // Send push notification unless a device is (or was recently) in the foreground
    if (
      (msg.type === "agent.text" || msg.type === "agent.media" || msg.type === "agent.a2ui") &&
      !this.shouldSuppressPush() &&
      (this.env.FCM_SERVICE_ACCOUNT_JSON || this.env.APNS_AUTH_KEY)
    ) {
      this.sendPushNotifications(msg).catch((err) => {
        console.error("[DO] Push notification failed:", err);
      });
    }
  }

  private async handleBrowserMessage(
    ws: WebSocket,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const attachment = ws.deserializeAttachment() as BrowserAttachment | null;

    // Handle browser auth — verify JWT token
    if (msg.type === "auth") {
      const token = msg.token as string | undefined;
      if (!token) {
        ws.send(JSON.stringify({ type: "auth.fail", reason: "Missing token" }));
        ws.close(4001, "Missing auth token");
        return;
      }

      const secret = getJwtSecret(this.env);
      const payload = await verifyToken(token, secret);
      if (!payload) {
        ws.send(JSON.stringify({ type: "auth.fail", reason: "Invalid or expired token" }));
        ws.close(4001, "Authentication failed");
        return;
      }

      // Verify the token's userId matches this DO's userId
      const doUserId = await this.state.storage.get<string>("userId");
      if (doUserId && payload.sub !== doUserId) {
        ws.send(JSON.stringify({ type: "auth.fail", reason: "User mismatch" }));
        ws.close(4001, "User mismatch");
        return;
      }

      ws.serializeAttachment({ ...attachment, authenticated: true });
      const doUserId2 = doUserId ?? payload.sub;

      // Fetch available agents from D1 for the auth.ok response
      let availableAgents: Array<{ id: string; name: string; type: string; role: string; capabilities: string[]; status: string }> = [];
      try {
        const { results } = await this.env.DB.prepare(
          "SELECT id, name, type, role, capabilities, status FROM agents WHERE user_id = ? ORDER BY created_at ASC",
        )
          .bind(doUserId2)
          .all<{ id: string; name: string; type: string; role: string; capabilities: string; status: string }>();
        availableAgents = (results ?? []).map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          role: r.role,
          capabilities: JSON.parse(r.capabilities || "[]"),
          status: r.status,
        }));
      } catch (err) {
        console.error("[DO] Failed to fetch agents for auth.ok:", err);
      }

      ws.send(JSON.stringify({ type: "auth.ok", userId: doUserId2, availableAgents }));

      // Send current connection status + cached models
      await this.ensureCachedModels();
      const openclawConnected = this.getOpenClawSocket() !== null;
      ws.send(
        JSON.stringify({
          type: "connection.status",
          openclawConnected,
          defaultModel: this.defaultModel,
          models: this.cachedModels,
          connectedAgents: availableAgents.filter((a) => a.status === "connected"),
        }),
      );
      return;
    }

    if (!attachment?.authenticated) {
      ws.send(JSON.stringify({ type: "auth.fail", reason: "Not authenticated" }));
      return;
    }

    // ---- Presence / focus tracking (stored in WS attachment, hibernation-safe) ----
    if (msg.type === "foreground.enter") {
      ws.serializeAttachment({
        ...attachment,
        foreground: true,
        sessionKey: (msg.sessionKey as string) ?? attachment.sessionKey ?? null,
        backgroundAt: null,
      } satisfies BrowserAttachment);
      return;
    }
    if (msg.type === "foreground.leave") {
      ws.serializeAttachment({
        ...attachment,
        foreground: false,
        backgroundAt: Date.now(),
      } satisfies BrowserAttachment);
      return;
    }
    if (msg.type === "focus.update") {
      ws.serializeAttachment({
        ...attachment,
        sessionKey: (msg.sessionKey as string) ?? null,
      } satisfies BrowserAttachment);
      return;
    }

    // Persist user messages to D1
    if (msg.type === "user.message") {
      console.log("[DO] User inbound:", JSON.stringify({
        type: msg.type,
        sessionKey: msg.sessionKey,
        messageId: msg.messageId,
        targetAgentId: msg.targetAgentId,
        hasMedia: !!msg.mediaUrl,
      }));
      await this.persistMessage({
        id: msg.messageId as string | undefined,
        sender: "user",
        sessionKey: msg.sessionKey as string,
        text: (msg.text ?? "") as string,
        mediaUrl: msg.mediaUrl as string | undefined,
        encrypted: msg.encrypted ? 1 : 0,
        targetAgentId: msg.targetAgentId as string | undefined,
      });
    }

    // Route user message to the target agent
    const targetAgentId = msg.targetAgentId as string | undefined;
    let targetWs: WebSocket | null = null;

    if (targetAgentId) {
      targetWs = this.getAgentSocket(targetAgentId);
    }
    if (!targetWs) {
      // No explicit target or target not found — try channel's default agent
      const sessionKey = msg.sessionKey as string | undefined;
      if (sessionKey) {
        const channelDefault = await this.resolveDefaultAgentId(sessionKey);
        if (channelDefault) {
          targetWs = this.getAgentSocket(channelDefault);
        }
      }
    }
    if (!targetWs) {
      // Final fallback: any connected agent (backward compat)
      targetWs = this.getAnyAgentSocket();
    }

    if (targetWs) {
      // Enrich thread messages with parent context
      const sessionKey = msg.sessionKey as string | undefined;
      const threadMatch = sessionKey?.match(/:thread:(.+)$/);
      let enrichedMsg = msg;
      if (threadMatch) {
        const parentId = threadMatch[1];
        try {
          const parentRow = await this.env.DB.prepare(
            `SELECT id, text, sender, encrypted FROM messages WHERE id = ? LIMIT 1`,
          )
            .bind(parentId)
            .first();
          if (parentRow) {
            enrichedMsg = {
              ...msg,
              parentMessageId: parentRow.id as string,
              parentText: (parentRow.text ?? "") as string,
              parentSender: parentRow.sender as string,
              parentEncrypted: (parentRow.encrypted ?? 0) as number,
            };
          }
        } catch (err) {
          console.error(`[DO] Failed to fetch parent message for thread:`, err);
        }
      }
      targetWs.send(JSON.stringify(enrichedMsg));
    } else {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "No agent is currently connected. Please check your agent instances.",
        }),
      );
    }
  }

  // ---- REST handlers ----

  /**
   * Fetch OpenClaw scan data in real time by sending task.scan.request to the
   * plugin and waiting for the task.scan.result response.
   * No local cache — data always comes directly from OpenClaw.
   */
  private async handleGetScanData(): Promise<Response> {
    const openclawWs = this.getOpenClawSocket();
    if (!openclawWs) {
      return Response.json(
        { error: "OpenClaw not connected", tasks: [] },
        { status: 503 },
      );
    }

    try {
      const tasks = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        this.pendingScanResolve = resolve;
        openclawWs.send(JSON.stringify({ type: "task.scan.request" }));

        // Timeout after 15 seconds
        setTimeout(() => {
          if (this.pendingScanResolve === resolve) {
            this.pendingScanResolve = null;
            reject(new Error("Scan request timed out"));
          }
        }, 15_000);
      });

      // Map to the fields the frontend needs
      const result = tasks.map((t) => ({
        cronJobId: t.cronJobId as string,
        schedule: (t.schedule as string) ?? "",
        instructions: (t.instructions as string) ?? "",
        model: (t.model as string) ?? "",
        enabled: t.enabled as boolean,
        encrypted: (t.encrypted as boolean) ?? false,
        iv: (t.iv as string) ?? undefined,
      }));
      return Response.json({ tasks: result });
    } catch (err) {
      console.error("[DO] Scan request failed:", err);
      return Response.json(
        { error: String(err), tasks: [] },
        { status: 504 },
      );
    }
  }

  private handleStatus(): Response {
    const sockets = this.state.getWebSockets();
    const openclawSocket = sockets.find((s) => {
      const t = this.getTag(s);
      return t === "openclaw" || t?.startsWith("agent:");
    });
    const browserCount = sockets.filter((s) =>
      this.getTag(s)?.startsWith("browser:"),
    ).length;

    let openclawAuthenticated = false;
    if (openclawSocket) {
      const att = openclawSocket.deserializeAttachment() as { authenticated: boolean } | null;
      openclawAuthenticated = att?.authenticated ?? false;
    }

    return Response.json({
      openclawConnected: !!openclawSocket,
      openclawAuthenticated,
      browserClients: browserCount,
    });
  }

  private async handleSendToOpenClaw(request: Request): Promise<Response> {
    const body = await request.json<Record<string, unknown>>();
    const openclawWs = this.getOpenClawSocket();

    if (!openclawWs) {
      return Response.json(
        { error: "OpenClaw not connected" },
        { status: 503 },
      );
    }

    openclawWs.send(JSON.stringify(body));
    return Response.json({ ok: true });
  }

  // ---- Helpers ----

  /** Read the user's notifyPreview preference from D1 settings_json. */
  private async getNotifyPreviewSetting(userId?: string | null): Promise<boolean> {
    const uid = userId ?? await this.state.storage.get<string>("userId");
    if (!uid) return false;
    try {
      const row = await this.env.DB.prepare(
        "SELECT settings_json FROM users WHERE id = ?",
      ).bind(uid).first<{ settings_json: string }>();
      if (row?.settings_json) {
        const settings = JSON.parse(row.settings_json);
        return settings.notifyPreview === true;
      }
    } catch (err) {
      console.error("[DO] Failed to read notifyPreview setting:", err);
    }
    return false;
  }

  /** Restore cachedModels and defaultModel from durable storage if in-memory cache is empty. */
  private async ensureCachedModels(): Promise<void> {
    if (this.cachedModels.length > 0) return;
    const stored = await this.state.storage.get<Array<{ id: string; name: string; provider: string }>>("cachedModels");
    if (stored && stored.length > 0) {
      this.cachedModels = stored;
    }
    if (!this.defaultModel) {
      const storedModel = await this.state.storage.get<string>("defaultModel");
      if (storedModel) this.defaultModel = storedModel;
    }
  }

  private getTag(ws: WebSocket): string | null {
    const att = ws.deserializeAttachment() as { tag?: string } | null;
    return att?.tag ?? null;
  }

  /** Get a specific agent's socket by agentId. */
  private getAgentSocket(agentId: string): WebSocket | null {
    const sockets = this.state.getWebSockets("agent:" + agentId);
    let newest: WebSocket | null = null;
    for (const s of sockets) {
      const att = s.deserializeAttachment() as { authenticated: boolean } | null;
      if (att?.authenticated) newest = s;
    }
    return newest ?? sockets[sockets.length - 1] ?? null;
  }

  /** Get any connected agent socket (new agent:xxx or legacy openclaw). */
  private getAnyAgentSocket(): WebSocket | null {
    const allSockets = this.state.getWebSockets();
    for (const s of allSockets) {
      const att = s.deserializeAttachment() as { authenticated: boolean; tag?: string } | null;
      if (att?.authenticated && att?.tag?.startsWith("agent:")) return s;
    }
    const legacySockets = this.state.getWebSockets("openclaw");
    for (const s of legacySockets) {
      const att = s.deserializeAttachment() as { authenticated: boolean } | null;
      if (att?.authenticated) return s;
    }
    return legacySockets[legacySockets.length - 1] ?? null;
  }

  private getOpenClawSocket(): WebSocket | null {
    return this.getAnyAgentSocket();
  }

  // ---- Agent-to-Agent delegation ----

  private async handleAgentRequest(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const MAX_DEPTH = 5;
    const TIMEOUT_MS = 5 * 60 * 1000;
    const depth = (msg.depth as number) ?? 0;
    const requestId = msg.requestId as string;
    const targetAgentId = msg.targetAgentId as string;
    const fromAtt = ws.deserializeAttachment() as { agentId?: string } | null;
    const fromAgentId = (msg.agentId as string) ?? fromAtt?.agentId ?? "unknown";

    if (depth >= MAX_DEPTH) {
      const originSocket = this.getAgentSocket(fromAgentId);
      if (originSocket) {
        originSocket.send(JSON.stringify({
          type: "agent.response",
          requestId,
          fromAgentId: targetAgentId,
          error: "Maximum delegation depth exceeded",
          sessionKey: msg.sessionKey,
        }));
      }
      return;
    }

    const targetSocket = this.getAgentSocket(targetAgentId);
    if (!targetSocket) {
      // Target agent offline — notify originator and broadcast system message
      const originSocket = this.getAgentSocket(fromAgentId);
      if (originSocket) {
        originSocket.send(JSON.stringify({
          type: "agent.response",
          requestId,
          fromAgentId: targetAgentId,
          error: `Agent ${targetAgentId} is currently offline`,
          sessionKey: msg.sessionKey,
        }));
      }
      this.broadcastToBrowsers(JSON.stringify({
        type: "system.message",
        text: `Agent delegation failed: target agent is offline`,
        sessionKey: msg.sessionKey,
      }));
      return;
    }

    // Track the pending request for response routing
    this.pendingRequests.set(requestId, {
      fromAgentId,
      sessionKey: msg.sessionKey as string,
      depth,
      createdAt: Date.now(),
    });

    // Clean up expired pending requests
    const now = Date.now();
    for (const [rid, pr] of this.pendingRequests) {
      if (now - pr.createdAt > TIMEOUT_MS) {
        this.pendingRequests.delete(rid);
      }
    }

    // Persist the delegation message to D1 (visible as agent-to-agent in chat)
    await this.persistMessage({
      sender: "agent",
      sessionKey: msg.sessionKey as string,
      text: (msg.text ?? "") as string,
      senderAgentId: fromAgentId,
      targetAgentId,
    });

    // Forward to target agent as a user.message (agents don't need to know it's a delegation)
    targetSocket.send(JSON.stringify({
      type: "user.message",
      sessionKey: msg.sessionKey,
      text: msg.text,
      userId: fromAgentId,
      messageId: requestId,
      targetAgentId,
      context: msg.context,
      depth: depth + 1,
    }));

    // Also broadcast to browser so user can see the delegation
    this.broadcastToBrowsers(JSON.stringify({
      type: "agent.text",
      agentId: fromAgentId,
      sessionKey: msg.sessionKey,
      text: msg.text,
      targetAgentId,
      isDelegation: true,
    }));
  }

  // ---- Verbose trace persistence ----

  private async handleAgentTrace(msg: Record<string, unknown>): Promise<void> {
    try {
      const userId = (await this.state.storage.get<string>("userId")) ?? "unknown";
      const id = generateIdUtil("mt_");
      await this.env.DB.prepare(
        `INSERT INTO message_traces (id, message_id, user_id, session_key, agent_id, verbose_level, trace_type, content, metadata_json, encrypted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          (msg.messageId ?? "") as string,
          userId,
          (msg.sessionKey ?? "") as string,
          (msg.agentId ?? "") as string,
          (msg.verboseLevel ?? 2) as number,
          (msg.traceType ?? "thinking") as string,
          (msg.content ?? "") as string,
          JSON.stringify(msg.metadata ?? {}),
          msg.encrypted ? 1 : 0,
        )
        .run();
    } catch (err) {
      console.error("[DO] Failed to persist agent trace:", err);
    }
  }

  private broadcastToBrowsers(message: string): void {
    const sockets = this.state.getWebSockets();
    for (const s of sockets) {
      const tag = this.getTag(s);
      if (tag?.startsWith("browser:")) {
        const att = s.deserializeAttachment() as { authenticated: boolean } | null;
        if (att?.authenticated) {
          try {
            s.send(message);
          } catch {
            // Socket might be closing, ignore
          }
        }
      }
    }
  }

  // ---- Presence helpers ----

  /**
   * Determine whether push notifications should be suppressed because a device
   * is (or was very recently) in the foreground.
   *
   * Checks three layers:
   * 1. Any connected browser socket with `foreground === true`
   * 2. Background grace: socket went background < BG_GRACE_MS ago
   * 3. Disconnect grace: socket disconnected < DC_GRACE_MS ago
   */
  private shouldSuppressPush(): boolean {
    const now = Date.now();

    // 1 + 2: scan connected browser sockets
    const sockets = this.state.getWebSockets();
    for (const s of sockets) {
      const att = s.deserializeAttachment() as BrowserAttachment | null;
      if (!att || !att.tag?.startsWith("browser:") || !att.authenticated) continue;
      if (att.foreground) return true;
      if (att.backgroundAt && now - att.backgroundAt < BG_GRACE_MS) return true;
    }

    // 3: recently disconnected sessions
    for (const [tag, disconnectedAt] of this.recentDisconnects) {
      if (now - disconnectedAt < DC_GRACE_MS) return true;
      // Expired — prune
      this.recentDisconnects.delete(tag);
    }

    return false;
  }

  // ---- Push notifications ----

  /**
   * Send push notifications to all of the user's registered devices.
   * Called when an agent message arrives and no browser session is in foreground.
   *
   * iOS tokens go directly to APNs (Capacitor returns raw APNs device tokens).
   * Web/Android tokens go through FCM HTTP v1 API.
   */
  private async sendPushNotifications(msg: Record<string, unknown>): Promise<void> {
    const userId = await this.state.storage.get<string>("userId");
    if (!userId) return;

    const { results } = await this.env.DB.prepare(
      "SELECT id, token, platform FROM push_tokens WHERE user_id = ?",
    )
      .bind(userId)
      .all<{ id: string; token: string; platform: string }>();

    if (!results || results.length === 0) return;
    console.log(`[DO] Push: ${results.length} token(s) for ${userId} (ios: ${results.filter((r) => r.platform === "ios").length})`);

    const data: Record<string, string> = {
      type: msg.type as string,
      sessionKey: (msg.sessionKey as string) ?? "",
      messageId: (msg.messageId as string) ?? "",
      encrypted: msg.encrypted ? "1" : "0",
    };

    let notifBody = "New message";
    if (msg.type === "agent.text") {
      data.text = (msg.text as string) ?? "";
      if (msg.encrypted && typeof msg.notifyPreview === "string" && msg.notifyPreview) {
        const preview = msg.notifyPreview as string;
        notifBody = preview.length > 100 ? preview.slice(0, 100) + "…" : preview;
      } else if (!msg.encrypted && data.text) {
        notifBody = data.text.length > 100 ? data.text.slice(0, 100) + "…" : data.text;
      } else if (msg.encrypted) {
        notifBody = "New encrypted message";
      }
    } else if (msg.type === "agent.media") {
      data.text = (msg.caption as string) || "";
      data.mediaUrl = (msg.mediaUrl as string) ?? "";
      notifBody = data.text || "Sent a media file";
    } else if (msg.type === "agent.a2ui") {
      data.text = "New interactive message";
      notifBody = "New interactive message";
    }

    const iosTokens = results.filter((r) => r.platform === "ios");
    const androidTokens = results.filter((r) => r.platform === "android");
    const webTokens = results.filter((r) => r.platform === "web");
    const invalidTokenIds: string[] = [];
    const notification = { title: "BotsChat", body: notifBody };

    // iOS: send via APNs directly (Capacitor registers raw APNs device tokens)
    if (iosTokens.length > 0 && this.env.APNS_AUTH_KEY) {
      const apnsConfig: ApnsConfig = {
        authKey: this.env.APNS_AUTH_KEY,
        keyId: this.env.APNS_KEY_ID ?? "",
        teamId: this.env.APNS_TEAM_ID ?? "",
        bundleId: "app.botschat.console",
      };
      await Promise.allSettled(
        iosTokens.map(async (row) => {
          const ok = await sendApnsNotification({
            config: apnsConfig,
            deviceToken: row.token,
            title: "BotsChat",
            body: notifBody,
            data,
          });
          if (!ok) invalidTokenIds.push(row.id);
        }),
      );
    }

    // Android: FCM with notification payload (data-only is silent in background)
    if (androidTokens.length > 0 && this.env.FCM_SERVICE_ACCOUNT_JSON) {
      const accessToken = await getFcmAccessToken(this.env.FCM_SERVICE_ACCOUNT_JSON);
      const projectId = this.env.FIREBASE_PROJECT_ID ?? "botschat-130ff";
      await Promise.allSettled(
        androidTokens.map(async (row) => {
          const ok = await sendPushNotification({
            accessToken,
            projectId,
            fcmToken: row.token,
            data,
            notification,
          });
          if (!ok) invalidTokenIds.push(row.id);
        }),
      );
    }

    // Web: FCM data-only (Service Worker decrypts + shows notification)
    if (webTokens.length > 0 && this.env.FCM_SERVICE_ACCOUNT_JSON) {
      const accessToken = await getFcmAccessToken(this.env.FCM_SERVICE_ACCOUNT_JSON);
      const projectId = this.env.FIREBASE_PROJECT_ID ?? "botschat-130ff";
      await Promise.allSettled(
        webTokens.map(async (row) => {
          const ok = await sendPushNotification({
            accessToken,
            projectId,
            fcmToken: row.token,
            data,
          });
          if (!ok) invalidTokenIds.push(row.id);
        }),
      );
    }

    // Clean up invalid/expired tokens
    for (const id of invalidTokenIds) {
      await this.env.DB.prepare("DELETE FROM push_tokens WHERE id = ?").bind(id).run();
      console.log(`[DO] Removed invalid push token: ${id}`);
    }
  }

  // ---- Media caching ----

  // ---- SSRF protection ----

  /** Check if a URL is safe to fetch (not pointing to private/internal networks). */
  private isUrlSafeToFetch(urlStr: string): boolean {
    try {
      const parsed = new URL(urlStr);
      // Only allow https (block http, ftp, file, etc.)
      if (parsed.protocol !== "https:") return false;

      const hostname = parsed.hostname;
      // Block private/reserved IP ranges and localhost
      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]" ||
        hostname.endsWith(".local") ||
        /^10\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^169\.254\./.test(hostname) || // link-local
        /^0\./.test(hostname) ||
        hostname === "[::ffff:127.0.0.1]"
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Download an external image and cache it in R2. Returns the local
   * API URL (e.g. /api/media/...) or null if caching fails.
   * Skips URLs that are already local (/api/media/...).
   */
  private async cacheExternalMedia(url: string): Promise<string | null> {
    // Skip already-cached URLs or data URIs
    if (url.startsWith("/api/media/") || url.startsWith("data:")) return null;
    // Also skip URLs that point back to our own media endpoint (absolute form)
    if (/\/api\/media\//.test(url)) return null;

    // SSRF protection: only allow HTTPS URLs to public hosts
    if (!this.isUrlSafeToFetch(url)) {
      console.warn(`[DO] cacheExternalMedia: blocked unsafe URL ${url.slice(0, 120)}`);
      return null;
    }

    console.log(`[DO] cacheExternalMedia: attempting to cache ${url.slice(0, 120)}`);

    const MAX_MEDIA_SIZE = 20 * 1024 * 1024; // 20 MB max

    try {
      const userId = (await this.state.storage.get<string>("userId")) ?? "unknown";

      // Download the external image — use arrayBuffer to avoid stream issues
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000); // 15s timeout
      let response: Response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",   // follow redirects, but URL was already validated
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        console.error(`[DO] cacheExternalMedia: HTTP ${response.status} for ${url.slice(0, 120)}`);
        return null;
      }

      const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";

      // Reject SVG (can contain scripts — XSS vector) and executable types
      if (contentType.includes("svg") || contentType.includes("javascript") || contentType.includes("executable")) {
        console.warn(`[DO] cacheExternalMedia: blocked dangerous Content-Type "${contentType}" from ${url.slice(0, 120)}`);
        return null;
      }

      // Check Content-Length header early if available
      const contentLength = parseInt(response.headers.get("Content-Length") ?? "0", 10);
      if (contentLength > MAX_MEDIA_SIZE) {
        console.warn(`[DO] cacheExternalMedia: Content-Length ${contentLength} exceeds limit for ${url.slice(0, 120)}`);
        return null;
      }

      // Read the body as ArrayBuffer for maximum compatibility with R2
      const body = await response.arrayBuffer();
      if (body.byteLength === 0) {
        console.warn(`[DO] cacheExternalMedia: empty body for ${url.slice(0, 120)}`);
        return null;
      }
      if (body.byteLength > MAX_MEDIA_SIZE) {
        console.warn(`[DO] cacheExternalMedia: body size ${body.byteLength} exceeds limit for ${url.slice(0, 120)}`);
        return null;
      }

      // Determine extension from Content-Type
      const extMap: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "application/pdf": "pdf",
        "audio/mpeg": "mp3",
        "audio/wav": "wav",
        "video/mp4": "mp4",
      };
      const ext = extMap[contentType] ?? (contentType.startsWith("image/") ? "png" : "bin");
      const key = `media/${userId}/${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;

      // Upload to R2
      await this.env.MEDIA.put(key, body, {
        httpMetadata: { contentType },
      });

      // Sign the cached media URL so the browser can fetch it without Bearer auth.
      // key is "media/{userId}/{filename}" — extract just the filename part.
      const cachedFilename = key.replace(`media/${userId}/`, "");
      const secret = getJwtSecret(this.env);
      const localUrl = await signMediaUrl(userId, cachedFilename, secret, 3600);
      console.log(`[DO] cacheExternalMedia: OK ${url.slice(0, 80)} → ${localUrl} (${body.byteLength} bytes)`);
      return localUrl;
    } catch (err) {
      console.error(`[DO] cacheExternalMedia: FAILED for ${url.slice(0, 120)}: ${err}`);
      return null;
    }
  }

  /**
   * Re-sign a media URL with a fresh signature. Handles both relative
   * (/api/media/...) and absolute (https://host/api/media/...) URLs.
   * Returns a freshly signed relative URL, or the original if not a media URL.
   */
  private async refreshMediaUrl(url: string, secret: string): Promise<string> {
    // Extract userId and filename from /api/media/:userId/:filename patterns
    const match = url.match(/\/api\/media\/([^/?]+)\/([^?]+)/);
    if (!match) return url; // Not a media URL — return as-is

    const userId = decodeURIComponent(match[1]);
    const filename = decodeURIComponent(match[2]);
    return signMediaUrl(userId, filename, secret, 3600);
  }

  // ---- Message persistence ----

  private async persistMessage(opts: {
    id?: string;
    sender: "user" | "agent";
    sessionKey: string;
    threadId?: string;
    text: string;
    mediaUrl?: string;
    a2ui?: string;
    encrypted?: number;
    senderAgentId?: string;
    targetAgentId?: string;
  }): Promise<void> {
    try {
      const userId = (await this.state.storage.get<string>("userId")) ?? "unknown";
      const id = opts.id ?? randomUUID();
      const encrypted = opts.encrypted ?? 0;

      // Extract threadId from sessionKey pattern: ....:thread:{threadId}
      let threadId = opts.threadId;
      if (!threadId) {
        const match = opts.sessionKey.match(/:thread:(.+)$/);
        if (match) threadId = match[1];
      }

      await this.env.DB.prepare(
        `INSERT INTO messages (id, user_id, session_key, thread_id, sender, text, media_url, a2ui, encrypted, sender_agent_id, target_agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, userId, opts.sessionKey, threadId ?? null, opts.sender, opts.text, opts.mediaUrl ?? null, opts.a2ui ?? null, encrypted, opts.senderAgentId ?? null, opts.targetAgentId ?? null)
        .run();
    } catch (err) {
      console.error("Failed to persist message:", err);
    }
  }

  private async handleGetMessages(url: URL): Promise<Response> {
    const sessionKey = url.searchParams.get("sessionKey");
    if (!sessionKey) {
      return Response.json({ error: "sessionKey required" }, { status: 400 });
    }
    const threadId = url.searchParams.get("threadId");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);

    try {
      let result;
      const replyCounts: Record<string, number> = {};

      if (threadId) {
        // Load thread messages
        result = await this.env.DB.prepare(
          `SELECT id, session_key, thread_id, sender, text, media_url, a2ui, encrypted, created_at
           FROM messages
           WHERE session_key = ? AND thread_id = ?
           ORDER BY created_at ASC
           LIMIT ?`,
        )
          .bind(sessionKey, threadId, limit)
          .all();
      } else {
        // Load main session messages (exclude thread messages from the main list)
        result = await this.env.DB.prepare(
          `SELECT id, session_key, thread_id, sender, text, media_url, a2ui, encrypted, created_at
           FROM messages
           WHERE session_key = ? AND thread_id IS NULL
           ORDER BY created_at ASC
           LIMIT ?`,
        )
          .bind(sessionKey, limit)
          .all();

        // Also load reply counts for all threads belonging to this session.
        // Use range-based prefix match instead of LIKE to avoid
        // "LIKE or GLOB pattern too complex" errors with long session keys.
        const prefixStart = `${sessionKey}:thread:`;
        const prefixEnd = `${sessionKey}:thread;`; // ';' is the char after ':' in ASCII
        const replyCountResult = await this.env.DB.prepare(
          `SELECT thread_id, COUNT(*) as count
           FROM messages
           WHERE thread_id IS NOT NULL AND session_key >= ? AND session_key < ?
           GROUP BY thread_id`,
        )
          .bind(prefixStart, prefixEnd)
          .all();

        for (const row of (replyCountResult.results ?? [])) {
          const tid = row.thread_id as string;
          const count = row.count as number;
          if (tid) replyCounts[tid] = count;
        }
      }

      // Re-sign media URLs so they're always fresh when loading history.
      // Stored URLs may have expired signatures or no signature at all.
      const secret = getJwtSecret(this.env);
      const messages = await Promise.all(
        (result.results ?? []).map(async (row: Record<string, unknown>) => {
          let mediaUrl = (row.media_url as string | null) ?? undefined;
          if (mediaUrl) {
            mediaUrl = await this.refreshMediaUrl(mediaUrl, secret);
          }
          const encBits = (row.encrypted as number) ?? 0;
          // Derive mediaEncrypted:
          // - User messages with encrypted=1: media was always encrypted by browser
          // - Any message with bit 1 set (encrypted >= 2): media was E2E encrypted
          const mediaEncrypted = (row.sender === "user" && encBits >= 1) || (encBits & 2) !== 0;
          return {
            id: row.id,
            sender: row.sender,
            text: row.text ?? "",
            timestamp: ((row.created_at as number) ?? 0) * 1000,
            mediaUrl,
            a2ui: row.a2ui ?? undefined,
            threadId: row.thread_id ?? undefined,
            encrypted: encBits,
            mediaEncrypted,
          };
        }),
      );

      return Response.json({ messages, replyCounts });
    } catch (err) {
      console.error("Failed to load messages:", err);
      return Response.json({ error: "Failed to load messages" }, { status: 500 });
    }
  }

  // ---- Task / Job handling ----

  /**
   * Handle task.scan.result from plugin — the plugin reports existing cron jobs.
   * We update tasks in D1 that match by cronJobId.
   * If a scanned cron job has no matching task, auto-create it under a "Default" channel.
   */
  private async handleTaskScanResult(msg: Record<string, unknown>): Promise<void> {
    try {
      const tasks = msg.tasks as Array<{
        cronJobId: string;
        name: string;
        schedule: string;
        agentId: string;
        enabled: boolean;
        instructions?: string;
        model?: string;
        lastRun?: { status: string; ts: number; summary?: string; durationMs?: number };
      }>;

      if (!Array.isArray(tasks) || tasks.length === 0) {
        // Resolve pending scan request even if empty
        if (this.pendingScanResolve) {
          this.pendingScanResolve([]);
          this.pendingScanResolve = null;
        }
        return;
      }

      // If a REST /scan-data request is waiting, resolve it with the raw data
      if (this.pendingScanResolve) {
        this.pendingScanResolve(tasks as unknown as Array<Record<string, unknown>>);
        this.pendingScanResolve = null;
      }

      const userId = (await this.state.storage.get<string>("userId")) ?? "unknown";

      // Lazily resolved default channel for orphan tasks
      let defaultChannelId: string | null = null;

      // Load the set of explicitly deleted cron job IDs so we skip them
      const deletedRows = await this.env.DB.prepare(
        "SELECT cron_job_id FROM deleted_cron_jobs WHERE user_id = ?",
      )
        .bind(userId)
        .all<{ cron_job_id: string }>();
      const deletedCronJobIds = new Set(
        (deletedRows.results ?? []).map((r) => r.cron_job_id),
      );

      // Track which cron job IDs were seen in this scan (for cleanup)
      const seenCronJobIds = new Set<string>();

      for (const t of tasks) {
        seenCronJobIds.add(t.cronJobId);

        // Skip cron jobs that the user explicitly deleted
        if (deletedCronJobIds.has(t.cronJobId)) {
          console.log(`[DO] Skipping deleted cron job: ${t.cronJobId}`);
          continue;
        }

        // Check if a matching task already exists
        const existingTask = await this.env.DB.prepare(
          "SELECT id, session_key FROM tasks WHERE provider_job_id = ?",
        )
          .bind(t.cronJobId)
          .first<{ id: string; session_key: string }>();

        if (existingTask) {
          // Update existing task from OpenClaw — only sync enabled (D1-owned).
          // Schedule, instructions, and model are NOT stored in D1.
          // They belong to OpenClaw and are delivered to the frontend via this
          // task.scan.result WebSocket message (broadcast to browsers below).
          const updateParts = [
            "enabled = ?",
            "updated_at = unixepoch()",
          ];
          const updateVals: unknown[] = [
            t.enabled ? 1 : 0,
            t.cronJobId,
          ];
          await this.env.DB.prepare(
            `UPDATE tasks SET ${updateParts.join(", ")} WHERE provider_job_id = ?`,
          )
            .bind(...updateVals)
            .run();
        } else {
          // No matching task — create one under the default channel
          if (!defaultChannelId) {
            defaultChannelId = await this.ensureDefaultChannel(userId);
          }

          const taskId = this.generateId("tsk_");
          const agentId = t.agentId || "main";
          const sessionKey = `agent:${agentId}:botschat:${userId}:task:${taskId}`;
          // Derive a friendly name: strip "botschat:" prefix if present
          const taskName = t.name.startsWith("botschat:") ? t.name.slice(9) : t.name;

          // D1 only stores basic task metadata — schedule/instructions/model
          // belong to OpenClaw and are delivered via task.scan.result WebSocket.
          await this.env.DB.prepare(
            `INSERT INTO tasks (id, channel_id, name, kind, provider_job_id, session_key, enabled)
             VALUES (?, ?, ?, 'background', ?, ?, ?)`,
          )
            .bind(taskId, defaultChannelId, taskName, t.cronJobId, sessionKey, t.enabled ? 1 : 0)
            .run();

          console.log(`[DO] Auto-imported task "${taskName}" (cronJobId=${t.cronJobId}) into default channel`);
        }

        // Resolve the task record for job persistence (may have just been created)
        const taskRecord = await this.env.DB.prepare(
          "SELECT id, session_key FROM tasks WHERE provider_job_id = ?",
        )
          .bind(t.cronJobId)
          .first<{ id: string; session_key: string }>();

        // If there's a last run, persist it as a job (insert or update summary/duration)
        if (t.lastRun && taskRecord) {
          const jobId = `job_scan_${t.cronJobId}_${t.lastRun.ts}`;
          const existing = await this.env.DB.prepare(
            "SELECT id FROM jobs WHERE id = ?",
          )
            .bind(jobId)
            .first();

          if (!existing) {
            await this.env.DB.prepare(
              `INSERT INTO jobs (id, task_id, user_id, session_key, status, started_at, duration_ms, summary)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
              .bind(
                jobId,
                taskRecord.id,
                userId,
                taskRecord.session_key ?? "",
                t.lastRun.status,
                t.lastRun.ts,
                t.lastRun.durationMs ?? null,
                t.lastRun.summary ?? "",
              )
              .run();
          } else if (t.lastRun.summary) {
            // Update summary/duration if we now have richer data from session files
            await this.env.DB.prepare(
              `UPDATE jobs SET summary = ?, duration_ms = COALESCE(?, duration_ms) WHERE id = ?`,
            )
              .bind(t.lastRun.summary, t.lastRun.durationMs ?? null, jobId)
              .run();
          }
        }
      }

      // Clean up deleted_cron_jobs entries for cron jobs that OpenClaw no
      // longer reports — they were successfully removed on the OpenClaw side.
      for (const deletedId of deletedCronJobIds) {
        if (!seenCronJobIds.has(deletedId)) {
          await this.env.DB.prepare(
            "DELETE FROM deleted_cron_jobs WHERE cron_job_id = ? AND user_id = ?",
          )
            .bind(deletedId, userId)
            .run();
          console.log(`[DO] Cleaned up deleted_cron_jobs entry: ${deletedId}`);
        }
      }
    } catch (err) {
      console.error("Failed to handle task scan result:", err);
    }
  }

  /**
   * Ensure a "Default" channel exists for the user. Returns the channel ID.
   */
  private async ensureDefaultChannel(userId: string): Promise<string> {
    // Check if a default channel already exists
    const existing = await this.env.DB.prepare(
      "SELECT id FROM channels WHERE user_id = ? AND provider_agent_id = 'main' ORDER BY created_at ASC LIMIT 1",
    )
      .bind(userId)
      .first<{ id: string }>();

    if (existing) return existing.id;

    // Create the default channel
    const channelId = this.generateId("ch_");
    await this.env.DB.prepare(
      "INSERT INTO channels (id, user_id, name, description, provider_agent_id, system_prompt) VALUES (?, ?, 'Default', 'Auto-created channel for imported background tasks', 'main', '')",
    )
      .bind(channelId, userId)
      .run();

    // Create the default adhoc task for this channel
    const taskId = this.generateId("tsk_");
    const sessionKey = `agent:main:botschat:${userId}:adhoc`;
    await this.env.DB.prepare(
      "INSERT INTO tasks (id, channel_id, name, kind, session_key) VALUES (?, ?, 'Ad Hoc Chat', 'adhoc', ?)",
    )
      .bind(taskId, channelId, sessionKey)
      .run();

    console.log(`[DO] Created default channel (${channelId}) for user ${userId}`);
    return channelId;
  }

  /**
   * Resolve a "@channelName" session key to a real adhoc task session key.
   * Resolve the default agent ID for a given session key.
   * Looks up the channel from the session key pattern and returns its default_agent_id.
   */
  private async resolveDefaultAgentId(sessionKey: string): Promise<string | null> {
    try {
      const userId = await this.state.storage.get<string>("userId");
      if (!userId) return null;

      // Try to find channel by matching session_key in sessions or tasks table
      const session = await this.env.DB.prepare(
        "SELECT channel_id FROM sessions WHERE session_key = ? AND user_id = ? LIMIT 1",
      )
        .bind(sessionKey.replace(/:thread:.+$/, ""), userId)
        .first<{ channel_id: string }>();

      const channelId = session?.channel_id;
      if (!channelId) return null;

      const channel = await this.env.DB.prepare(
        "SELECT default_agent_id FROM channels WHERE id = ? LIMIT 1",
      )
        .bind(channelId)
        .first<{ default_agent_id: string | null }>();

      return channel?.default_agent_id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * - "@default" → first channel (by created_at ASC)
   * - "@SomeName" → channel matched by name (case-insensitive)
   * Returns the original sessionKey if it doesn't start with "@".
   */
  private async resolveChannelSessionKey(rawSessionKey: string): Promise<string> {
    if (!rawSessionKey.startsWith("@")) return rawSessionKey;

    const userId = await this.state.storage.get<string>("userId");
    if (!userId) {
      console.error("[DO] resolveChannelSessionKey: no userId in storage");
      return rawSessionKey;
    }

    const isDefault = rawSessionKey.toLowerCase() === "@default";
    const channelName = isDefault ? null : rawSessionKey.slice(1);

    let channel: { id: string; provider_agent_id: string } | null = null;

    if (channelName) {
      channel = await this.env.DB.prepare(
        "SELECT id, provider_agent_id FROM channels WHERE user_id = ? AND LOWER(name) = LOWER(?) LIMIT 1",
      )
        .bind(userId, channelName)
        .first<{ id: string; provider_agent_id: string }>();
    }

    if (!channel) {
      channel = await this.env.DB.prepare(
        "SELECT id, provider_agent_id FROM channels WHERE user_id = ? ORDER BY created_at ASC LIMIT 1",
      )
        .bind(userId)
        .first<{ id: string; provider_agent_id: string }>();
    }

    if (!channel) {
      const channelId = await this.ensureDefaultChannel(userId);
      channel = { id: channelId, provider_agent_id: "main" };
    }

    const task = await this.env.DB.prepare(
      "SELECT session_key FROM tasks WHERE channel_id = ? AND kind = 'adhoc' LIMIT 1",
    )
      .bind(channel.id)
      .first<{ session_key: string }>();

    if (task?.session_key) {
      console.log(`[DO] Resolved ${rawSessionKey} → ${task.session_key}`);
      return task.session_key;
    }

    const taskId = this.generateId("tsk_");
    const agentId = channel.provider_agent_id || "main";
    const sessionKey = `agent:${agentId}:botschat:${userId}:adhoc`;
    await this.env.DB.prepare(
      "INSERT INTO tasks (id, channel_id, name, kind, session_key) VALUES (?, ?, 'Ad Hoc Chat', 'adhoc', ?)",
    )
      .bind(taskId, channel.id, sessionKey)
      .run();
    console.log(`[DO] Created adhoc task for channel ${channel.id}, resolved ${rawSessionKey} → ${sessionKey}`);
    return sessionKey;
  }

  /** Generate a short random ID (URL-safe) using CSPRNG (bias-free). */
  private generateId(prefix = ""): string {
    return generateIdUtil(prefix);
  }

  /**
   * Handle job.update from plugin — a cron job ran and reported results.
   * Persist the job in D1.
   */
  private async handleJobUpdate(msg: Record<string, unknown>): Promise<void> {
    try {
      const userId = (await this.state.storage.get<string>("userId")) ?? "unknown";
      const cronJobId = msg.cronJobId as string;
      const jobId = (msg.jobId as string) ?? `job_${cronJobId}_${Date.now()}`;
      const sessionKey = (msg.sessionKey as string) ?? "";
      const status = (msg.status as string) ?? "ok";
      const summary = (msg.summary as string) ?? "";
      const startedAt = (msg.startedAt as number) ?? Math.floor(Date.now() / 1000);
      const finishedAt = msg.finishedAt as number | undefined;
      const durationMs = msg.durationMs as number | undefined;

      // Find the task by cronJobId
      const task = await this.env.DB.prepare(
        "SELECT id FROM tasks WHERE provider_job_id = ?",
      )
        .bind(cronJobId)
        .first<{ id: string }>();

      if (!task) {
        console.error(`Job update: no task found for cronJobId ${cronJobId}`);
        return;
      }

      const encrypted = msg.encrypted ? 1 : 0;

      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO jobs (id, task_id, user_id, session_key, status, started_at, finished_at, duration_ms, summary, encrypted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          jobId,
          task.id,
          userId,
          sessionKey,
          status,
          startedAt,
          finishedAt ?? null,
          durationMs ?? null,
          summary,
          encrypted,
        )
        .run();
    } catch (err) {
      console.error("Failed to handle job update:", err);
    }
  }

  private async validatePairingToken(token: string): Promise<boolean> {
    // The API worker validates pairing tokens against D1 before routing
    // to the DO (and passes ?verified=1). Connections that arrive here
    // pre-verified are fast-tracked in handleOpenClawMessage.
    //
    // For tokens that arrive WITHOUT pre-verification (e.g. direct DO
    // access, which shouldn't happen in normal flow), we validate
    // against D1 ourselves and cache the result with a TTL.

    if (!token || !token.startsWith("bc_pat_") || token.length < 20) {
      return false;
    }

    // Check DO-local cache first (with 30-second TTL — short to ensure
    // revoked tokens are invalidated quickly)
    const cacheKey = `token:${token}`;
    const cached = await this.state.storage.get<{ valid: boolean; cachedAt: number }>(cacheKey);
    if (cached) {
      const ageMs = Date.now() - cached.cachedAt;
      if (ageMs < 30_000) return cached.valid; // 30-second TTL
      // Expired — fall through to re-validate
    }

    // Validate against D1
    try {
      const row = await this.env.DB.prepare(
        "SELECT user_id FROM pairing_tokens WHERE token = ? AND revoked_at IS NULL",
      )
        .bind(token)
        .first<{ user_id: string }>();

      const isValid = !!row;
      try {
        await this.state.storage.put(cacheKey, { valid: isValid, cachedAt: Date.now() });
      } catch {
        // Non-critical — skip caching if storage is full
      }
      return isValid;
    } catch (err) {
      console.error("[DO] Failed to validate pairing token against D1:", err);
      return false;
    }
  }
}
