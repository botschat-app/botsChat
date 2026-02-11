import type { Env } from "../env.js";
import { verifyToken, getJwtSecret } from "../utils/auth.js";
import { generateId as generateIdUtil } from "../utils/id.js";

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
 * - "openclaw" = the WebSocket from the OpenClaw plugin
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

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** Handle incoming HTTP requests (WebSocket upgrades). */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Route: /gateway/:accountId — OpenClaw plugin connects here
    if (url.pathname.startsWith("/gateway/")) {
      // Extract and store userId from the gateway path
      const userId = url.pathname.split("/gateway/")[1]?.split("?")[0];
      if (userId) {
        await this.state.storage.put("userId", userId);
      }
      // Check if the API worker already verified the token against D1
      const preVerified = url.searchParams.get("verified") === "1";
      return this.handleOpenClawConnect(request, preVerified);
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
    const tag = this.getTag(ws);
    const data = typeof message === "string" ? message : new TextDecoder().decode(message);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // Ignore malformed JSON
    }

    if (tag === "openclaw") {
      // Message from OpenClaw → handle auth or forward to browsers
      await this.handleOpenClawMessage(ws, parsed);
    } else if (tag?.startsWith("browser:")) {
      // Message from browser → forward to OpenClaw
      await this.handleBrowserMessage(ws, parsed);
    }
  }

  /** Called when a WebSocket is closed. */
  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const tag = this.getTag(ws);
    if (tag === "openclaw") {
      // OpenClaw disconnected — notify all browser clients
      this.broadcastToBrowsers(
        JSON.stringify({ type: "openclaw.disconnected" }),
      );
    }
    // No explicit cleanup needed — the runtime manages the socket list
  }

  /** Called when a WebSocket encounters an error. */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const tag = this.getTag(ws);
    console.error(`WebSocket error for ${tag}:`, error);
  }

  // ---- Connection handlers ----

  private handleOpenClawConnect(request: Request, preVerified = false): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept with Hibernation API, tag as "openclaw"
    this.state.acceptWebSocket(server, ["openclaw"]);

    // If the API worker already verified the token against D1, mark as
    // pre-verified. The plugin still sends an auth message, which we'll
    // fast-track through without re-validating the token.
    server.serializeAttachment({ authenticated: false, tag: "openclaw", preVerified });

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleBrowserConnect(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const sessionId = url.pathname.split("/client/")[1] || crypto.randomUUID();

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const tag = `browser:${sessionId}`;
    this.state.acceptWebSocket(server, [tag]);
    server.serializeAttachment({ authenticated: false, tag });

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
        ws.serializeAttachment({ ...attachment, authenticated: true });
        // Include userId so the plugin can derive the E2E key
        const userId = await this.state.storage.get<string>("userId");
        console.log(`[DO] auth.ok → userId=${userId}`);
        ws.send(JSON.stringify({ type: "auth.ok", userId }));
        // Store gateway default model from plugin auth
        if (msg.model) {
          this.defaultModel = msg.model as string;
          await this.state.storage.put("defaultModel", this.defaultModel);
        }
        // After auth, request task scan + models list from the plugin
        ws.send(JSON.stringify({ type: "task.scan.request" }));
        ws.send(JSON.stringify({ type: "models.request" }));
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
      let persistedMediaUrl = msg.mediaUrl as string | undefined;
      if (msg.type === "agent.media" && persistedMediaUrl) {
        const cachedUrl = await this.cacheExternalMedia(persistedMediaUrl);
        if (cachedUrl) {
          persistedMediaUrl = cachedUrl;
          // Update the message object so browsers get the cached URL
          msg.mediaUrl = cachedUrl;
        }
      }

      await this.persistMessage({
        id: msg.messageId as string | undefined,
        sender: "agent",
        sessionKey: msg.sessionKey as string,
        threadId: (msg.threadId ?? msg.replyToId) as string | undefined,
        text: (msg.text ?? msg.caption ?? "") as string,
        mediaUrl: persistedMediaUrl,
        a2ui: msg.jsonl as string | undefined,
        encrypted: msg.encrypted ? 1 : 0,
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
          "UPDATE tasks SET openclaw_cron_job_id = ? WHERE id = ?",
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

    // Handle models list from plugin — persist to storage and broadcast to browsers
    if (msg.type === "models.list") {
      this.cachedModels = (msg.models as Array<{ id: string; name: string; provider: string }>) ?? [];
      await this.state.storage.put("cachedModels", this.cachedModels);
      console.log(`[DO] Persisted ${this.cachedModels.length} models to storage, broadcasting connection.status`);
      this.broadcastToBrowsers(
        JSON.stringify({ type: "connection.status", openclawConnected: true, defaultModel: this.defaultModel, models: this.cachedModels }),
      );
    }

    // Plugin applied BotsChat default model to OpenClaw config — update and broadcast
    if (msg.type === "defaultModel.updated" && typeof msg.model === "string") {
      this.defaultModel = msg.model;
      await this.state.storage.put("defaultModel", this.defaultModel);
      this.broadcastToBrowsers(
        JSON.stringify({ type: "connection.status", openclawConnected: true, defaultModel: this.defaultModel, models: this.cachedModels }),
      );
    }

    // Handle job updates from plugin — persist and forward to browsers
    if (msg.type === "job.update") {
      await this.handleJobUpdate(msg);
    }

    // Forward all messages to browser clients
    this.broadcastToBrowsers(JSON.stringify(msg));
  }

  private async handleBrowserMessage(
    ws: WebSocket,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const attachment = ws.deserializeAttachment() as { authenticated: boolean; tag: string } | null;

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
      // Include userId so the browser can derive the E2E key
      const doUserId2 = doUserId ?? payload.sub;
      ws.send(JSON.stringify({ type: "auth.ok", userId: doUserId2 }));

      // Send current OpenClaw connection status + cached models
      await this.ensureCachedModels();
      const openclawConnected = this.getOpenClawSocket() !== null;
      ws.send(
        JSON.stringify({
          type: "connection.status",
          openclawConnected,
          defaultModel: this.defaultModel,
          models: this.cachedModels,
        }),
      );
      return;
    }

    if (!attachment?.authenticated) {
      ws.send(JSON.stringify({ type: "auth.fail", reason: "Not authenticated" }));
      return;
    }

    // Persist user messages to D1
    if (msg.type === "user.message") {
      console.log("[DO] User inbound:", JSON.stringify({
        type: msg.type,
        sessionKey: msg.sessionKey,
        messageId: msg.messageId,
        hasMedia: !!msg.mediaUrl,
      }));
      await this.persistMessage({
        id: msg.messageId as string | undefined,
        sender: "user",
        sessionKey: msg.sessionKey as string,
        text: (msg.text ?? "") as string,
        mediaUrl: msg.mediaUrl as string | undefined,
        encrypted: msg.encrypted ? 1 : 0,
      });
    }

    // Forward user messages to OpenClaw
    const openclawWs = this.getOpenClawSocket();
    if (openclawWs) {
      openclawWs.send(JSON.stringify(msg));
    } else {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "OpenClaw is not connected. Please check your OpenClaw instance.",
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
    const openclawSocket = sockets.find((s) => this.getTag(s) === "openclaw");
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

  private getOpenClawSocket(): WebSocket | null {
    const sockets = this.state.getWebSockets("openclaw");
    // Return the first authenticated OpenClaw socket
    for (const s of sockets) {
      const att = s.deserializeAttachment() as { authenticated: boolean } | null;
      if (att?.authenticated) return s;
    }
    return sockets[0] ?? null;
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

      const contentType = response.headers.get("Content-Type") ?? "image/png";
      // Validate that the response is actually an image
      if (!contentType.startsWith("image/")) {
        console.warn(`[DO] cacheExternalMedia: non-image Content-Type "${contentType}", skipping ${url.slice(0, 120)}`);
        return null;
      }

      // Reject SVG (can contain scripts — XSS vector)
      if (contentType.includes("svg")) {
        console.warn(`[DO] cacheExternalMedia: blocked SVG content from ${url.slice(0, 120)}`);
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

      // Determine extension from Content-Type (no SVG)
      const extMap: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
      };
      const ext = extMap[contentType] ?? "png";
      const key = `media/${userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

      // Upload to R2
      await this.env.MEDIA.put(key, body, {
        httpMetadata: { contentType },
      });

      const localUrl = `/api/media/${key.replace("media/", "")}`;
      console.log(`[DO] cacheExternalMedia: OK ${url.slice(0, 80)} → ${localUrl} (${body.byteLength} bytes)`);
      return localUrl;
    } catch (err) {
      console.error(`[DO] cacheExternalMedia: FAILED for ${url.slice(0, 120)}: ${err}`);
      return null;
    }
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
  }): Promise<void> {
    try {
      const userId = (await this.state.storage.get<string>("userId")) ?? "unknown";
      const id = opts.id ?? crypto.randomUUID();
      const encrypted = opts.encrypted ?? 0;

      // Extract threadId from sessionKey pattern: ....:thread:{threadId}
      let threadId = opts.threadId;
      if (!threadId) {
        const match = opts.sessionKey.match(/:thread:(.+)$/);
        if (match) threadId = match[1];
      }

      await this.env.DB.prepare(
        `INSERT INTO messages (id, user_id, session_key, thread_id, sender, text, media_url, a2ui, encrypted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, userId, opts.sessionKey, threadId ?? null, opts.sender, opts.text, opts.mediaUrl ?? null, opts.a2ui ?? null, encrypted)
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

      const messages = (result.results ?? []).map((row: Record<string, unknown>) => ({
        id: row.id,
        sender: row.sender,
        text: row.text ?? "",
        timestamp: ((row.created_at as number) ?? 0) * 1000, // unix seconds → ms
        mediaUrl: row.media_url ?? undefined,
        a2ui: row.a2ui ?? undefined,
        threadId: row.thread_id ?? undefined,
        encrypted: row.encrypted ?? 0,
      }));

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
          "SELECT id, session_key FROM tasks WHERE openclaw_cron_job_id = ?",
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
            `UPDATE tasks SET ${updateParts.join(", ")} WHERE openclaw_cron_job_id = ?`,
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
            `INSERT INTO tasks (id, channel_id, name, kind, openclaw_cron_job_id, session_key, enabled)
             VALUES (?, ?, ?, 'background', ?, ?, ?)`,
          )
            .bind(taskId, defaultChannelId, taskName, t.cronJobId, sessionKey, t.enabled ? 1 : 0)
            .run();

          console.log(`[DO] Auto-imported task "${taskName}" (cronJobId=${t.cronJobId}) into default channel`);
        }

        // Resolve the task record for job persistence (may have just been created)
        const taskRecord = await this.env.DB.prepare(
          "SELECT id, session_key FROM tasks WHERE openclaw_cron_job_id = ?",
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
      "SELECT id FROM channels WHERE user_id = ? AND openclaw_agent_id = 'main' ORDER BY created_at ASC LIMIT 1",
    )
      .bind(userId)
      .first<{ id: string }>();

    if (existing) return existing.id;

    // Create the default channel
    const channelId = this.generateId("ch_");
    await this.env.DB.prepare(
      "INSERT INTO channels (id, user_id, name, description, openclaw_agent_id, system_prompt) VALUES (?, ?, 'Default', 'Auto-created channel for imported background tasks', 'main', '')",
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
        "SELECT id FROM tasks WHERE openclaw_cron_job_id = ?",
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
      await this.state.storage.put(cacheKey, { valid: isValid, cachedAt: Date.now() });
      return isValid;
    } catch (err) {
      console.error("[DO] Failed to validate pairing token against D1:", err);
      return false;
    }
  }
}
