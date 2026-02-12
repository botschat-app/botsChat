import WebSocket from "ws";
import { deriveKey } from "./e2e-crypto.js";
import type { CloudInbound, CloudOutbound } from "./types.js";

export type BotsChatCloudClientOptions = {
  cloudUrl: string;
  accountId: string;
  pairingToken: string;
  e2ePassword?: string;
  agentIds?: string[];
  /** Current agent model name (e.g. "claude-opus-4-6") — sent with auth and status pings */
  getModel?: () => string | undefined;
  onMessage: (msg: CloudInbound) => void;
  onStatusChange: (connected: boolean) => void;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
};

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Manages a persistent outbound WebSocket connection from the OpenClaw
 * plugin to the BotsChat cloud (ConnectionDO on Cloudflare).
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Auth handshake on connect
 * - Ping/pong keepalive
 * - Graceful shutdown
 */
export class BotsChatCloudClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = MIN_BACKOFF_MS;
  private intentionalClose = false;
  private _connected = false;
  public e2eKey: Uint8Array | null = null;

  constructor(private opts: BotsChatCloudClientOptions) {}

  get connected(): boolean {
    return this._connected;
  }

  /** Establish the outbound WSS connection. */
  connect(): void {
    this.intentionalClose = false;
    // Normalise cloudUrl: strip any existing scheme and pick ws:// or wss://
    let host = this.opts.cloudUrl.replace(/^https?:\/\//, "");
    const isPlainHttp = this.opts.cloudUrl.startsWith("http://");
    const wsScheme = isPlainHttp ? "ws" : "wss";
    // Pass the pairing token as a query parameter so the API worker
    // can resolve the BotsChat user ID before routing to the DO.
    const url = `${wsScheme}://${host}/api/gateway/${this.opts.accountId}?token=${encodeURIComponent(this.opts.pairingToken)}`;
    this.log("info", `Connecting to ${wsScheme}://${host}/api/gateway/${this.opts.accountId}`);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.log("error", `Failed to create WebSocket: ${err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.log("info", "WebSocket connected, sending auth");
      this.sendRaw({
        type: "auth",
        token: this.opts.pairingToken,
        agents: this.opts.agentIds,
        model: this.opts.getModel?.(),
      });
      // Don't set connected yet — wait for auth.ok
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as CloudInbound;
        void this.handleMessage(msg);
      } catch (err) {
        this.log("error", `Failed to parse message: ${err}`);
      }
    });

    this.ws.on("close", (code, reason) => {
      this.log(
        "warn",
        `WebSocket closed: code=${code} reason=${reason?.toString() ?? ""}`,
      );
      this.setConnected(false);
      this.stopPing();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
      this.log("error", `WebSocket error: ${err.message}`);
      // The "close" event will fire after this, triggering reconnect
    });
  }

  /** Send a message to the BotsChat cloud. */
  send(msg: CloudOutbound): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log("warn", "Cannot send — WebSocket not open");
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  /** Gracefully disconnect. */
  disconnect(): void {
    this.intentionalClose = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "shutdown");
      this.ws = null;
    }
    this.setConnected(false);
  }

  // ---- internal ----

  private async handleMessage(msg: CloudInbound): Promise<void> {
    switch (msg.type) {
      case "auth.ok":
        this.log("info", `Authenticated with BotsChat cloud (userId=${msg.userId}, hasE2ePwd=${!!this.opts.e2ePassword})`);
        // Mark connected FIRST so that subsequent messages (task.scan.request,
        // models.request) arriving while deriveKey is running can be processed.
        this.backoffMs = MIN_BACKOFF_MS;
        this.setConnected(true);
        this.startPing();
        // Derive E2E key AFTER marking connected (PBKDF2 is slow ~1-2s).
        if (msg.userId && this.opts.e2ePassword) {
            this.log("info", `Deriving E2E key for userId: ${msg.userId}`);
            try {
                this.e2eKey = await deriveKey(this.opts.e2ePassword, msg.userId);
                this.log("info", "E2E key derived successfully");
            } catch (err) {
                this.log("error", `Failed to derive E2E key: ${err}`);
            }
        }
        break;
      case "auth.fail":
        this.log("error", `Authentication failed: ${msg.reason}`);
        this.intentionalClose = true; // don't reconnect on auth failure
        this.ws?.close(4001, "auth failed");
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      default:
        // Forward all other messages to the handler
        this.opts.onMessage(msg);
        break;
    }
  }

  private sendRaw(msg: CloudOutbound): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    this.log("info", `Reconnecting in ${this.backoffMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      this.connect();
    }, this.backoffMs);
  }

  private startPing(): void {
    this.stopPing();
    // Send a status ping every 25 seconds to keep the connection alive
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({
          type: "status",
          connected: true,
          agents: this.opts.agentIds ?? [],
          model: this.opts.getModel?.(),
        });
      }
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setConnected(value: boolean): void {
    if (this._connected !== value) {
      this._connected = value;
      this.opts.onStatusChange(value);
    }
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    const logger = this.opts.log;
    if (logger) {
      logger[level](`[botschat] ${msg}`);
    }
  }
}
