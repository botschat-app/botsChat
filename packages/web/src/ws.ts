/** WebSocket client for connecting to the BotsChat ConnectionDO. */

import { Capacitor } from "@capacitor/core";
import { dlog } from "./debug-log";
import { E2eService } from "./e2e";
import { getToken, tryRefreshAccessToken } from "./api";

export type WSMessage = {
  type: string;
  [key: string]: unknown;
};

export type WSClientOptions = {
  userId: string;
  sessionId: string;
  /** Function that returns the current access token (reads from localStorage). */
  getToken: () => string | null;
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

    // In Capacitor (native app), WebView runs from capacitor:// so we must
    // use the full production WebSocket URL.
    let url: string;
    if (Capacitor.isNativePlatform()) {
      url = `wss://console.botschat.app/api/ws/${this.opts.userId}/${this.opts.sessionId}`;
    } else {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      url = `${protocol}//${window.location.host}/api/ws/${this.opts.userId}/${this.opts.sessionId}`;
    }

    dlog.info("WS", `Connecting to ${url}`);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      dlog.info("WS", "Socket opened, sending auth");
      const token = this.opts.getToken();
      if (!token) {
        dlog.error("WS", "No access token available, closing");
        this.ws?.close();
        return;
      }
      // Authenticate with the ConnectionDO
      this.ws!.send(JSON.stringify({ type: "auth", token }));
    };

    this.ws.onmessage = async (evt) => {
      try {
        const msg = JSON.parse(evt.data) as WSMessage;
        
        // Handle E2E Decryption
        console.log(`[E2E-WS] msg.type=${msg.type} encrypted=${msg.encrypted} hasKey=${E2eService.hasKey()} messageId=${msg.messageId}`);
        if (msg.encrypted && E2eService.hasKey()) {
           try {
             if (msg.type === "agent.text" || msg.type === "agent.media") {
                // Decrypt text/caption
                const text = msg.text as string | undefined;
                const caption = msg.caption as string | undefined;
                const messageId = msg.messageId as string;
                
                if (text && messageId) {
                    msg.text = await E2eService.decrypt(text, messageId);
                    msg.encrypted = false;
                }
                if (caption && messageId) {
                    msg.caption = await E2eService.decrypt(caption, messageId);
                     msg.encrypted = false;
                }
             } else if (msg.type === "job.update") {
                const summary = msg.summary as string;
                 // Job ID is contextId
                const jobId = msg.jobId as string;
                if (summary && jobId) {
                    msg.summary = await E2eService.decrypt(summary, jobId);
                    msg.encrypted = false;
                }
             }
           } catch (err) {
               dlog.warn("E2E", "Decryption failed", err);
               msg.decryptionError = true;
           }
        }
        
        // Handle Task Scan Results (array items)
        if (msg.type === "task.scan.result" && Array.isArray(msg.tasks) && E2eService.hasKey()) {
            for (const t of msg.tasks) {
                if (t.encrypted && t.iv) {
                    try {
                        if (t.schedule) t.schedule = await E2eService.decrypt(t.schedule, t.iv);
                        if (t.instructions) t.instructions = await E2eService.decrypt(t.instructions, t.iv);
                        t.encrypted = false;
                    } catch (err) {
                         dlog.warn("E2E", `Task decryption failed for ${t.cronJobId}`, err);
                         t.decryptionError = true;
                    }
                }
            }
        }

        if (msg.type === "auth.ok") {
          dlog.info("WS", "Auth OK — connected");
          
          // Try to load E2E password
          const userId = msg.userId as string;
          console.log(`[E2E-WS] auth.ok userId=${userId}, hasSavedPwd=${E2eService.hasSavedPassword()}`);
          if (userId && E2eService.hasSavedPassword()) {
              const loaded = await E2eService.loadSavedPassword(userId);
              console.log(`[E2E-WS] loadSavedPassword result=${loaded}, hasKey=${E2eService.hasKey()}`);
          }
          
          this.backoffMs = 1000;
          this._connected = true;
          this.opts.onStatusChange(true);
          this.opts.onMessage(msg);
        } else {
          this.opts.onMessage(msg);
        }
      } catch (err) {
        dlog.warn("WS", "Failed to process incoming message", err);
      }
    };

    this.ws.onclose = (evt) => {
      this._connected = false;
      this.opts.onStatusChange(false);
      if (!this.intentionalClose) {
        const isAuthFail = evt.code === 4001;
        dlog.warn("WS", `Connection closed (code=${evt.code}), reconnecting in ${this.backoffMs}ms${isAuthFail ? " (will refresh token)" : ""}`);
        this.reconnectTimer = setTimeout(async () => {
          this.backoffMs = Math.min(this.backoffMs * 2, 30000);
          // On auth failure (4001), refresh the access token before reconnecting
          if (isAuthFail) {
            dlog.info("WS", "Refreshing access token before reconnect...");
            const ok = await tryRefreshAccessToken();
            if (ok) {
              dlog.info("WS", "Token refreshed, reconnecting");
              this.backoffMs = 1000; // reset backoff on successful refresh
            } else {
              dlog.error("WS", "Token refresh failed — will retry on next cycle");
            }
          }
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

  async send(msg: WSMessage): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // E2E Encryption for user messages
      if (msg.type === "user.message" && E2eService.hasKey() && typeof msg.text === "string") {
          try {
              // Use the existing messageId as contextId for encryption nonce,
              // so decryption on the plugin side uses the same ID.
              const existingId = (msg.messageId as string) || undefined;
              const { ciphertext, messageId } = await E2eService.encrypt(msg.text, existingId);
              msg.text = ciphertext;
              // Only set messageId if we didn't have one — preserve the original
              // so message IDs stay consistent between local state and server.
              if (!existingId) {
                msg.messageId = messageId;
              }
              msg.encrypted = true;
          } catch (err) {
              dlog.error("E2E", "Encryption failed", err);
              return; 
          }
      }
      
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
