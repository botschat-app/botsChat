/**
 * APNs HTTP/2 API — send push notifications directly to iOS devices.
 *
 * Uses a .p8 Auth Key for token-based authentication (ES256 JWT).
 * iOS devices register raw APNs device tokens (hex strings) via Capacitor,
 * which cannot be sent through FCM. This module talks to APNs directly.
 */

let cachedJwt: string | null = null;
let cachedJwtExpiry = 0;

export type ApnsConfig = {
  authKey: string;
  keyId: string;
  teamId: string;
  bundleId: string;
};

async function getApnsJwt(config: ApnsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwtExpiry > now + 300) {
    return cachedJwt;
  }

  const header = { alg: "ES256", kid: config.keyId };
  const claims = { iss: config.teamId, iat: now };

  const key = await importP8Key(config.authKey);
  cachedJwt = await signEs256Jwt(header, claims, key);
  cachedJwtExpiry = now + 3600;
  return cachedJwt;
}

export type ApnsPushOpts = {
  config: ApnsConfig;
  deviceToken: string;
  title: string;
  body: string;
  /** Custom data included alongside the aps payload. */
  data?: Record<string, string>;
};

/**
 * Send a visible push notification via APNs.
 * Returns true on success.
 * Returns false if the token is permanently invalid (410 Unregistered)
 * so the caller can clean it up.
 */
export async function sendApnsNotification(opts: ApnsPushOpts): Promise<boolean> {
  const jwt = await getApnsJwt(opts.config);

  const payload: Record<string, unknown> = {
    aps: {
      alert: { title: opts.title, body: opts.body },
      sound: "default",
      "mutable-content": 1,
    },
  };
  if (opts.data) {
    payload.custom = opts.data;
  }

  const headers = {
    Authorization: `Bearer ${jwt}`,
    "apns-topic": opts.config.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": "0",
  };
  const body = JSON.stringify(payload);

  // Try production first, fall back to sandbox for debug/TestFlight builds
  for (const host of ["api.push.apple.com", "api.sandbox.push.apple.com"]) {
    const res = await fetch(`https://${host}/3/device/${opts.deviceToken}`, {
      method: "POST",
      headers,
      body,
    });

    if (res.ok) {
      console.log(`[APNs] Sent via ${host} for ...${opts.deviceToken.slice(-8)}`);
      return true;
    }

    const err = await res.text();
    const isBadToken = err.includes("BadDeviceToken");

    // BadDeviceToken on production → likely a sandbox token, try sandbox next
    if (host === "api.push.apple.com" && res.status === 400 && isBadToken) {
      console.log(`[APNs] Production rejected token, trying sandbox...`);
      continue;
    }

    console.error(`[APNs] ${host} failed for ...${opts.deviceToken.slice(-8)}: ${res.status} ${err}`);

    // 410 = device unregistered — safe to remove
    if (res.status === 410) return false;
    return !isBadToken;
  }

  return true;
}

// ---- ES256 JWT helpers ----

async function importP8Key(pem: string): Promise<CryptoKey> {
  // Handle literal "\n" escape sequences from env vars (.dev.vars / wrangler secret)
  const normalized = pem.replace(/\\n/g, "\n");
  const pemBody = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(pemBody);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    der[i] = binary.charCodeAt(i);
  }
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

function base64url(data: Uint8Array | string): string {
  const str =
    typeof data === "string"
      ? btoa(data)
      : btoa(String.fromCharCode(...data));
  return str.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signEs256Jwt(
  header: Record<string, string>,
  payload: Record<string, unknown>,
  key: CryptoKey,
): Promise<string> {
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const input = `${headerB64}.${payloadB64}`;

  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(input),
  );

  return `${input}.${base64url(new Uint8Array(sig))}`;
}
