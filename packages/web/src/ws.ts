/** WebSocket client for connecting to the BotsChat ConnectionDO. */

import { dlog } from "./debug-log";

export type WSMessage = {
  type: string;
  [key: string]: unknown;
};

export type WSClientOptions = {
  userId: string;
  sessionId: string;
  token: string;
  onMessage: (msg: WSMessage) => void;
  onStatusChange: (connected: boolean) => void;
};

export class BotsChatWSClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private intentionalClose = false;
  private _connected = false;

  constructor(private opts: WSClientOptions) {}

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    this.intentionalClose = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Token is NOT included in the URL to avoid leaking it in logs/history.
    // Authentication is handled via the "auth" message after connection.
    const url = `${protocol}//${window.location.host}/api/ws/${this.opts.userId}/${this.opts.sessionId}`;

    dlog.info("WS", `Connecting to ${url}`);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      dlog.info("WS", "Socket opened, sending auth");
      // Authenticate with the ConnectionDO
      this.ws!.send(JSON.stringify({ type: "auth", token: this.opts.token }));
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as WSMessage;
        if (msg.type === "auth.ok") {
          dlog.info("WS", "Auth OK — connected");
          this.backoffMs = 1000;
          this._connected = true;
          this.opts.onStatusChange(true);
        } else {
          this.opts.onMessage(msg);
        }
      } catch {
        dlog.warn("WS", "Failed to parse incoming message", evt.data);
      }
    };

    this.ws.onclose = (evt) => {
      this._connected = false;
      this.opts.onStatusChange(false);
      if (!this.intentionalClose) {
        dlog.warn("WS", `Connection closed (code=${evt.code}), reconnecting in ${this.backoffMs}ms`);
        this.reconnectTimer = setTimeout(() => {
          this.backoffMs = Math.min(this.backoffMs * 2, 30000);
          this.connect();
        }, this.backoffMs);
      } else {
        dlog.info("WS", "Connection closed (intentional)");
      }
    };

    this.ws.onerror = () => {
      dlog.error("WS", "WebSocket error (close event will follow)");
    };
  }

  send(msg: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      dlog.warn("WS", `Cannot send — socket not open (readyState=${this.ws?.readyState})`, msg);
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    this.opts.onStatusChange(false);
  }
}
