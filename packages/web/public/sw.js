// Minimal service worker for PWA installability + Push notifications.
// Caches the app shell on install for faster startup.

const CACHE_NAME = "botschat-v1";
const SHELL_URLS = ["/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Clean up old caches
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Network-first strategy — always try network, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful GET responses
        if (event.request.method === "GET" && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ---- Push Notification Handling ----

// E2E decryption helpers (inlined from e2e-crypto to work in SW context).
// The SW cannot access localStorage, so the E2E key is stored in IndexedDB
// by the main app and read here for decryption.

const IDB_NAME = "botschat-sw";
const IDB_STORE = "keys";
const IDB_KEY = "e2e_key";

/** Open the IndexedDB database. */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Read the cached E2E key (Uint8Array) from IndexedDB. */
async function getE2eKey() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** HKDF-SHA256 nonce derivation (matches e2e-crypto). */
async function hkdfNonce(key, contextId) {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    key.buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const info = new TextEncoder().encode("nonce-" + contextId);
  const input = new Uint8Array(info.length + 1);
  input.set(info);
  input[info.length] = 0x01;
  const full = await crypto.subtle.sign("HMAC", hmacKey, input.buffer);
  return new Uint8Array(full).slice(0, 16);
}

/** Decrypt ciphertext (base64) using AES-256-CTR (matches e2e-crypto). */
async function decryptText(keyBytes, ciphertextB64, contextId) {
  // base64 decode
  const binary = atob(ciphertextB64);
  const ciphertext = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    ciphertext[i] = binary.charCodeAt(i);
  }

  const counter = await hkdfNonce(keyBytes, contextId);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer,
    { name: "AES-CTR" },
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-CTR", counter: counter.buffer, length: 128 },
    aesKey,
    ciphertext.buffer
  );
  return new TextDecoder().decode(plaintext);
}

self.addEventListener("push", (event) => {
  const promise = (async () => {
    let data = {};
    if (event.data) {
      try {
        data = event.data.json();
      } catch {
        data = { text: event.data.text() };
      }
    }

    // FCM wraps the data payload; extract it
    const payload = data.data || data;
    const msgType = payload.type || "agent.text";
    const isEncrypted = payload.encrypted === "1";
    const messageId = payload.messageId || "";

    let title = "BotsChat";
    let body = "New message";

    if (isEncrypted && messageId && payload.text) {
      // Attempt client-side E2E decryption
      const key = await getE2eKey();
      if (key) {
        try {
          body = await decryptText(key, payload.text, messageId);
          if (body.length > 200) body = body.slice(0, 200) + "\u2026";
        } catch {
          body = "New encrypted message";
        }
      } else {
        body = "New encrypted message";
      }
    } else if (payload.text) {
      body = payload.text;
      if (body.length > 200) body = body.slice(0, 200) + "\u2026";
    } else if (msgType === "agent.media") {
      body = "Sent an image";
    } else if (msgType === "agent.a2ui") {
      body = "New interactive message";
    }

    const options = {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      tag: "botschat-message",
      renotify: true,
      data: payload,
    };

    return self.registration.showNotification(title, options);
  })();

  event.waitUntil(promise);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (
            client.url.includes("console.botschat.app") ||
            client.url.includes("localhost")
          ) {
            return client.focus();
          }
        }
        return clients.openWindow("https://console.botschat.app");
      })
  );
});
