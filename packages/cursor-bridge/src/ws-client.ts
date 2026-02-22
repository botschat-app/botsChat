/**
 * WebSocket client for connecting to BotsChat Cloud.
 * Adapted from packages/plugin/src/ws-client.ts for the Cursor Bridge.
 */

import WebSocket from "ws";

export type BridgeConfig = {
  cloudUrl: string;       // e.g. "http://localhost:8788" or "https://botschat-v2.auxtenwpc.workers.dev"
  pairingToken: string;   // bc_pat_xxx or API key
  agentId: string;        // agt_xxx
  onMessage: (msg: Record<string, unknown>) => void;
  onConnect: () => void;
  onDisconnect: () => void;
};

export class BotsChatWSClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private shouldReconnect = true;

  constructor(private config: BridgeConfig) {}

  connect() {
    this.shouldReconnect = true;
    this._connect();
  }

  private _connect() {
    const baseUrl = this.config.cloudUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");

    const url = `${baseUrl}/api/gateway/default?token=${encodeURIComponent(this.config.pairingToken)}`;
    console.log(`[ws] Connecting to ${baseUrl}...`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log("[ws] Connected, sending auth...");
      this.reconnectDelay = 1000;
      this.sendJson({
        type: "auth",
        token: this.config.pairingToken,
        agentId: this.config.agentId,
        agentType: "cursor_cli",
      });

      this.pingInterval = setInterval(() => {
        this.sendJson({ type: "pong" });
      }, 25000);
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "auth.ok") {
          console.log(`[ws] Authenticated as agent ${this.config.agentId} (user: ${msg.userId})`);
          this.connected = true;
          this.config.onConnect();
        } else if (msg.type === "auth.fail") {
          console.error(`[ws] Auth failed: ${msg.reason}`);
        } else if (msg.type === "ping") {
          this.sendJson({ type: "pong" });
        } else {
          this.config.onMessage(msg);
        }
      } catch (err) {
        console.error("[ws] Failed to parse message:", err);
      }
    });

    this.ws.on("close", (code) => {
      console.log(`[ws] Disconnected (code: ${code})`);
      this.connected = false;
      this.config.onDisconnect();
      this.cleanupPing();

      if (code === 4009) {
        console.log("[ws] Replaced by another connection, not reconnecting");
        return;
      }

      if (this.shouldReconnect) {
        console.log(`[ws] Reconnecting in ${this.reconnectDelay}ms...`);
        setTimeout(() => this._connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    });

    this.ws.on("error", (err) => {
      console.error("[ws] Error:", err.message);
    });
  }

  sendJson(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect() {
    this.shouldReconnect = false;
    this.cleanupPing();
    this.ws?.close(1000, "Bridge shutting down");
    this.ws = null;
  }

  isConnected() {
    return this.connected;
  }

  private cleanupPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
