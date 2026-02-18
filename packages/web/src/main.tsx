import React from "react";
import ReactDOM from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import App from "./App";
import "./index.css";
import { initAnalytics } from "./analytics";

initAnalytics();

// ---- Capacitor native platform setup ----
if (Capacitor.isNativePlatform()) {
  // Configure status bar and keyboard for native app
  import("@capacitor/status-bar").then(({ StatusBar, Style }) => {
    const isDark = document.documentElement.getAttribute("data-theme") !== "light";
    StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light }).catch(() => {});
    StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
  });
  import("@capacitor/keyboard").then(({ Keyboard }) => {
    Keyboard.setAccessoryBarVisible({ isVisible: true }).catch(() => {});
    // Write keyboard height to CSS variable so MobileLayout can shrink accordingly.
    // This works with Keyboard.resize = "none" to avoid body-resize jitter.
    Keyboard.addListener("keyboardWillShow", (info) => {
      document.documentElement.style.setProperty("--keyboard-height", `${info.keyboardHeight}px`);
    });
    Keyboard.addListener("keyboardWillHide", () => {
      document.documentElement.style.setProperty("--keyboard-height", "0px");
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register service worker for PWA support — skip in Capacitor (native has its own caching)
if (!Capacitor.isNativePlatform() && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW registration failed — non-critical, app still works
    });
  });
}
