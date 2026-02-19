/**
 * FCM HTTP v1 API — send push notifications from Cloudflare Workers.
 *
 * Uses a Google Service Account to obtain OAuth2 access tokens,
 * then sends data-only messages via FCM so clients can decrypt
 * E2E-encrypted content before showing notifications.
 */

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri: string;
};

// Module-level token cache (survives within DO lifecycle)
let cachedAccessToken: string | null = null;
let cachedTokenExpiry = 0;

/**
 * Get a valid Google OAuth2 access token for FCM.
 * Caches the token in memory; refreshes 5 minutes before expiry.
 */
export async function getFcmAccessToken(serviceAccountJson: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedTokenExpiry > now + 300) {
    return cachedAccessToken;
  }

  const sa: ServiceAccount = JSON.parse(serviceAccountJson);

  // Build JWT assertion for Google OAuth2
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const key = await importPKCS8Key(sa.private_key);
  const jwt = await signJwt(header, claims, key);

  // Exchange JWT for access token
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`FCM OAuth2 token exchange failed: ${res.status} ${err}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  cachedTokenExpiry = now + data.expires_in;
  return data.access_token;
}

export type PushPayload = {
  accessToken: string;
  projectId: string;
  fcmToken: string;
  /** Data payload — sent as FCM data-only message so client can decrypt + show notification. */
  data: Record<string, string>;
};

/**
 * Send a data-only push notification via FCM HTTP v1 API.
 * Returns true on success. Returns false if the token is invalid (404/410)
 * so the caller can clean it up.
 */
export async function sendPushNotification(opts: PushPayload): Promise<boolean> {
  const url = `https://fcm.googleapis.com/v1/projects/${opts.projectId}/messages:send`;

  const message = {
    message: {
      token: opts.fcmToken,
      data: opts.data,
      android: {
        priority: "high" as const,
      },
      webpush: {
        headers: {
          Urgency: "high",
        },
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[FCM] Send failed for token ...${opts.fcmToken.slice(-8)}: ${res.status} ${err}`);
    // Token invalid/expired — caller should remove it
    if (res.status === 404 || res.status === 410) return false;
  }
  return res.ok;
}

// ---- Crypto helpers for RS256 JWT signing ----

async function importPKCS8Key(pem: string): Promise<CryptoKey> {
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");
  const binary = atob(pemContents);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    der[i] = binary.charCodeAt(i);
  }
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64url(data: string | Uint8Array): string {
  const str = typeof data === "string" ? btoa(data) : btoa(String.fromCharCode(...data));
  return str.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signJwt(
  header: Record<string, string>,
  payload: Record<string, unknown>,
  key: CryptoKey,
): Promise<string> {
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const input = `${headerB64}.${payloadB64}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  const sigB64 = base64url(new Uint8Array(sig));
  return `${input}.${sigB64}`;
}
