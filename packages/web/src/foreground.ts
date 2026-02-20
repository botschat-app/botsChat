/**
 * Foreground/background detection & channel-level focus tracking.
 *
 * Notifies the ConnectionDO via WebSocket so it knows whether to send push
 * notifications and which session the user is currently viewing.
 */

import { Capacitor } from "@capacitor/core";
import type { BotsChatWSClient } from "./ws";
import { dlog } from "./debug-log";

export interface ForegroundOptions {
  wsClient: BotsChatWSClient;
  getActiveSessionKey: () => string | null;
  onResume?: () => void;
}

export interface ForegroundHandle {
  cleanup: () => void;
  /** Re-send the current foreground/background state. Call after WS auth succeeds. */
  resend: () => void;
}

/**
 * Send a focus.update message when the user switches channels/sessions
 * while already in the foreground.
 */
export function sendFocusUpdate(
  wsClient: BotsChatWSClient,
  sessionKey: string | null,
): void {
  wsClient.send({ type: "focus.update", sessionKey });
  dlog.info("Foreground", `Focus updated: ${sessionKey ?? "(none)"}`);
}

export function setupForegroundDetection(opts: ForegroundOptions): ForegroundHandle {
  const { wsClient, getActiveSessionKey, onResume } = opts;

  const notifyForeground = () => {
    wsClient.send({ type: "foreground.enter", sessionKey: getActiveSessionKey() });
    onResume?.();
    dlog.info("Foreground", "Entered foreground");
  };

  const notifyBackground = () => {
    wsClient.send({ type: "foreground.leave" });
    dlog.info("Foreground", "Entered background");
  };

  if (Capacitor.isNativePlatform()) {
    let cleanup: (() => void) | null = null;
    let nativeIsActive = true;

    import("@capacitor/app").then(({ App }) => {
      const handle = App.addListener("appStateChange", ({ isActive }) => {
        nativeIsActive = isActive;
        if (isActive) notifyForeground();
        else notifyBackground();
      });
      cleanup = () => handle.then((h) => h.remove());
    });

    notifyForeground();

    return {
      cleanup: () => cleanup?.(),
      resend: () => { if (nativeIsActive) notifyForeground(); else notifyBackground(); },
    };
  }

  // Web: Use Page Visibility API
  const handleVisibilityChange = () => {
    if (document.hidden) notifyBackground();
    else notifyForeground();
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);

  if (!document.hidden) notifyForeground();

  return {
    cleanup: () => document.removeEventListener("visibilitychange", handleVisibilityChange),
    resend: () => { if (!document.hidden) notifyForeground(); else notifyBackground(); },
  };
}
