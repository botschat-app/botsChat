/**
 * Foreground/background detection — notifies the ConnectionDO via WebSocket
 * so it knows whether to send push notifications.
 */

import { Capacitor } from "@capacitor/core";
import type { BotsChatWSClient } from "./ws";
import { dlog } from "./debug-log";

export function setupForegroundDetection(wsClient: BotsChatWSClient): () => void {
  const notifyForeground = () => {
    wsClient.send({ type: "foreground.enter" });
    dlog.info("Foreground", "Entered foreground");
  };

  const notifyBackground = () => {
    wsClient.send({ type: "foreground.leave" });
    dlog.info("Foreground", "Entered background");
  };

  if (Capacitor.isNativePlatform()) {
    let cleanup: (() => void) | null = null;

    import("@capacitor/app").then(({ App }) => {
      const handle = App.addListener("appStateChange", ({ isActive }) => {
        if (isActive) notifyForeground();
        else notifyBackground();
      });
      cleanup = () => handle.then((h) => h.remove());
    });

    // Report initial foreground state once WS is connected
    notifyForeground();

    return () => cleanup?.();
  }

  // Web: Use Page Visibility API
  const handleVisibilityChange = () => {
    if (document.hidden) notifyBackground();
    else notifyForeground();
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);

  if (!document.hidden) notifyForeground();

  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
