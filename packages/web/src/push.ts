/**
 * Push notification initialization for Web (FCM) and Native (Capacitor).
 *
 * - Web: Firebase Cloud Messaging + Service Worker
 * - iOS/Android: @capacitor/push-notifications
 *
 * For E2E encrypted messages, the E2E key is synced to IndexedDB so the
 * Service Worker (web) or native handler can decrypt before showing.
 */

import { Capacitor } from "@capacitor/core";
import { pushApi } from "./api";
import { dlog } from "./debug-log";
import { E2eService } from "./e2e";

let initialized = false;

// ---- Push navigation (deep-link on notification tap) ----

let pendingNavSessionKey: string | null = null;

export function getPendingPushNav(): string | null {
  return pendingNavSessionKey;
}

export function clearPendingPushNav(): void {
  pendingNavSessionKey = null;
}

function firePushNav(sessionKey: string): void {
  pendingNavSessionKey = sessionKey;
  window.dispatchEvent(
    new CustomEvent("botschat:push-nav", { detail: { sessionKey } }),
  );
}

// ---- IndexedDB helpers for SW E2E key sync ----

const IDB_NAME = "botschat-sw";
const IDB_STORE = "keys";
const IDB_KEY = "e2e_key";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Sync the current E2E key to IndexedDB so the Service Worker can decrypt. */
export async function syncE2eKeyToSW(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);

    // Read the cached key from localStorage (base64-encoded Uint8Array)
    const cachedKeyB64 = localStorage.getItem("botschat_e2e_key_cache");
    if (cachedKeyB64) {
      // Decode base64 to Uint8Array and store in IDB
      const binary = atob(cachedKeyB64);
      const key = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        key[i] = binary.charCodeAt(i);
      }
      store.put(key, IDB_KEY);
    } else {
      store.delete(IDB_KEY);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    dlog.warn("Push", "Failed to sync E2E key to SW IndexedDB", err);
  }
}

/** Clear the E2E key from SW IndexedDB (call on logout or key clear). */
export async function clearE2eKeyFromSW(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore — best effort
  }
}

// ---- macOS native notification bridge ----

declare global {
  interface Window {
    __BOTSCHAT_NATIVE__?: boolean;
    __BOTSCHAT_PLATFORM__?: string;
    __BOTSCHAT_NATIVE_NOTIFY__?: (payload: {
      title: string;
      body: string;
      sessionKey?: string;
    }) => void;
    __BOTSCHAT_NATIVE_REQUEST_PERMISSION__?: () => void;
  }
}

function isMacOSNative(): boolean {
  return !!(window.__BOTSCHAT_NATIVE__ && window.__BOTSCHAT_PLATFORM__ === "macos");
}

async function initMacOSPush(): Promise<void> {
  try {
    window.__BOTSCHAT_NATIVE_REQUEST_PERMISSION__?.();
    dlog.info("Push", "macOS native notification permission requested");
  } catch (err) {
    dlog.error("Push", "macOS notification init failed", err);
  }
}

/**
 * Show a native macOS notification when a message arrives via WS and
 * the window is not focused. Call this from the WS message handler.
 */
export function notifyIfBackground(msg: {
  type: string;
  text?: string;
  caption?: string;
  sessionKey?: string;
  agentName?: string;
}): void {
  if (!isMacOSNative()) return;
  if (!document.hidden && document.hasFocus()) return;
  if (!window.__BOTSCHAT_NATIVE_NOTIFY__) return;

  let body = "";
  const title = msg.agentName || "BotsChat";

  if (msg.type === "agent.text" && msg.text) {
    body = msg.text.length > 200 ? msg.text.slice(0, 200) + "…" : msg.text;
  } else if (msg.type === "agent.media") {
    body = msg.caption || "Sent a media file";
  } else {
    return;
  }

  window.__BOTSCHAT_NATIVE_NOTIFY__({ title, body, sessionKey: msg.sessionKey });
}

// ---- Service Worker message listener (notification click → navigation) ----

function setupSWMessageListener(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "push-nav" && event.data.sessionKey) {
      dlog.info("Push", `SW postMessage push-nav: ${event.data.sessionKey}`);
      firePushNav(event.data.sessionKey);
    }
  });

  // Also check URL for push_session param (when SW opens a new window)
  const params = new URLSearchParams(window.location.search);
  const pushSession = params.get("push_session");
  if (pushSession) {
    dlog.info("Push", `URL push_session param: ${pushSession}`);
    firePushNav(pushSession);
    // Clean up the URL parameter
    params.delete("push_session");
    const clean = params.toString();
    const newUrl = window.location.pathname + (clean ? "?" + clean : "") + window.location.hash;
    window.history.replaceState({}, "", newUrl);
  }
}

// ---- Push initialization ----

export async function initPushNotifications(): Promise<void> {
  if (initialized) return;

  // Listen for SW notification-click messages (must be before any early return)
  setupSWMessageListener();

  // Sync E2E key so push notifications can be decrypted
  await syncE2eKeyToSW();

  // Subscribe to E2E key changes to keep SW in sync
  E2eService.subscribe(() => {
    syncE2eKeyToSW().catch(() => {});
  });

  if (isMacOSNative()) {
    await initMacOSPush();
  } else if (Capacitor.isNativePlatform()) {
    await initNativePush();
  } else {
    await initWebPush();
  }

  initialized = true;
}

// ---- Web Push (Firebase Cloud Messaging) ----

async function initWebPush(): Promise<void> {
  try {
    if (!("Notification" in self)) {
      dlog.warn("Push", "Notifications not supported in this browser");
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      dlog.warn("Push", "Notification permission denied");
      return;
    }

    const { getMessaging, getToken, onMessage } = await import("firebase/messaging");
    const { ensureFirebaseApp } = await import("./firebase");

    const firebaseApp = ensureFirebaseApp();
    if (!firebaseApp) {
      dlog.warn("Push", "Firebase not configured (missing env vars)");
      return;
    }

    const messaging = getMessaging(firebaseApp);

    // Get service worker registration
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
      dlog.warn("Push", "No service worker registration found");
      return;
    }

    const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string;
    if (!vapidKey) {
      dlog.warn("Push", "VITE_FIREBASE_VAPID_KEY not set — skipping web push");
      return;
    }

    const fcmToken = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: registration,
    });

    if (fcmToken) {
      dlog.info("Push", `FCM token obtained (${fcmToken.slice(0, 20)}...)`);
      await pushApi.register(fcmToken, "web");
      dlog.info("Push", "Token registered with backend");
    }

    // Suppress foreground notifications (WS already delivers the message)
    onMessage(messaging, (_payload) => {
      dlog.info("Push", "Foreground FCM message received (suppressed)");
    });
  } catch (err) {
    dlog.error("Push", "Web push init failed", err);
  }
}

// ---- Native Push (Capacitor) ----

async function initNativePush(): Promise<void> {
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");

    const permResult = await PushNotifications.requestPermissions();
    if (permResult.receive !== "granted") {
      dlog.warn("Push", "Native push permission denied");
      return;
    }

    await PushNotifications.register();

    PushNotifications.addListener("registration", async (token) => {
      dlog.info("Push", `Native push token: ${token.value.slice(0, 20)}...`);
      const platform = Capacitor.getPlatform() as "ios" | "android";
      await pushApi.register(token.value, platform);
      dlog.info("Push", "Native token registered with backend");
    });

    PushNotifications.addListener("registrationError", (error) => {
      dlog.error("Push", "Native push registration failed", error);
    });

    PushNotifications.addListener("pushNotificationReceived", (_notification) => {
      dlog.info("Push", "Foreground native notification (suppressed)");
    });

    PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      dlog.info("Push", "Notification tapped", action);
      // iOS: custom data nested under "custom" key; Android: at root level
      const data = action.notification?.data;
      const sessionKey: string | undefined =
        data?.custom?.sessionKey || data?.sessionKey;
      if (sessionKey) {
        dlog.info("Push", `Push nav target: ${sessionKey}`);
        firePushNav(sessionKey);
      }
    });
  } catch (err) {
    dlog.error("Push", "Native push init failed", err);
  }
}

/** Unregister push token (call on logout). */
export async function unregisterPush(): Promise<void> {
  initialized = false;
  await clearE2eKeyFromSW();
}
