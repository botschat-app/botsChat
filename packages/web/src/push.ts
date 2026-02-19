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

// ---- Push initialization ----

export async function initPushNotifications(): Promise<void> {
  if (initialized) return;

  // Sync E2E key so push notifications can be decrypted
  await syncE2eKeyToSW();

  // Subscribe to E2E key changes to keep SW in sync
  E2eService.subscribe(() => {
    syncE2eKeyToSW().catch(() => {});
  });

  if (Capacitor.isNativePlatform()) {
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

    // Data-only messages arrive here in foreground — suppress (WS handles it)
    PushNotifications.addListener("pushNotificationReceived", (_notification) => {
      dlog.info("Push", "Foreground native notification (suppressed)");
    });

    // User tapped a notification (app was in background)
    PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      dlog.info("Push", "Notification tapped", action);
      // TODO: navigate to specific session from action.notification.data
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
