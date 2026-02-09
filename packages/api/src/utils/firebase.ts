/**
 * Firebase ID Token verification for Cloudflare Workers.
 *
 * Since we can't use Firebase Admin SDK on edge runtimes, we verify
 * Firebase ID tokens manually using Google's JWKS public keys.
 */

// Google's JWKS endpoint for Firebase Auth tokens
const GOOGLE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const FIREBASE_TOKEN_ISSUER_PREFIX = "https://securetoken.google.com/";

// Cache the JWKS keys in memory (refreshed every 6 hours)
let cachedKeys: JsonWebKey[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export type FirebaseTokenPayload = {
  sub: string; // Firebase UID
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  auth_time: number;
  firebase: {
    sign_in_provider: string;
    identities: Record<string, string[]>;
  };
};

/** Fetch Google's JWKS public keys (with in-memory cache). */
async function getGooglePublicKeys(): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (cachedKeys && now - cachedAt < CACHE_TTL_MS) {
    return cachedKeys;
  }

  const resp = await fetch(GOOGLE_JWKS_URL);
  if (!resp.ok) {
    throw new Error(`Failed to fetch Google JWKS: ${resp.status}`);
  }

  const jwks = (await resp.json()) as { keys: JsonWebKey[] };
  cachedKeys = jwks.keys;
  cachedAt = now;
  return jwks.keys;
}

/** Base64url decode (no padding). */
function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Parse a JWT without verifying (to extract header.kid). */
function parseJwtUnverified(token: string): {
  header: { alg: string; kid: string; typ?: string };
  payload: FirebaseTokenPayload;
  signatureBytes: Uint8Array;
  signedContent: string;
} {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");

  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  const signatureBytes = base64UrlDecode(parts[2]);
  const signedContent = `${parts[0]}.${parts[1]}`;

  return { header, payload, signatureBytes, signedContent };
}

/**
 * Verify a Firebase ID token and return the decoded payload.
 *
 * Checks:
 * 1. Token is a valid JWT with RS256 algorithm
 * 2. Signed by one of Google's public keys (kid match)
 * 3. Issuer matches the Firebase project
 * 4. Audience matches the Firebase project
 * 5. Token is not expired
 * 6. Subject (uid) is non-empty
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
): Promise<FirebaseTokenPayload> {
  // 1. Parse token
  const { header, payload, signatureBytes, signedContent } =
    parseJwtUnverified(idToken);

  // 2. Check algorithm
  if (header.alg !== "RS256") {
    throw new Error(`Unsupported algorithm: ${header.alg}`);
  }

  // 3. Find matching public key
  const keys = await getGooglePublicKeys();
  const matchingKey = keys.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!matchingKey) {
    // Keys might be rotated — force refresh and retry once
    cachedKeys = null;
    const freshKeys = await getGooglePublicKeys();
    const retryKey = freshKeys.find((k) => (k as { kid?: string }).kid === header.kid);
    if (!retryKey) {
      throw new Error(`No matching key found for kid: ${header.kid}`);
    }
    return verifyWithKey(retryKey, signedContent, signatureBytes, payload, projectId);
  }

  return verifyWithKey(matchingKey, signedContent, signatureBytes, payload, projectId);
}

async function verifyWithKey(
  jwk: JsonWebKey,
  signedContent: string,
  signatureBytes: Uint8Array,
  payload: FirebaseTokenPayload,
  projectId: string,
): Promise<FirebaseTokenPayload> {
  // Import the public key
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  // Verify signature
  const encoder = new TextEncoder();
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signatureBytes,
    encoder.encode(signedContent),
  );

  if (!valid) {
    throw new Error("Invalid token signature");
  }

  // Validate claims
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp < now) {
    throw new Error("Token has expired");
  }

  if (payload.iat > now + 300) {
    // Allow 5 min clock skew
    throw new Error("Token issued in the future");
  }

  const expectedIssuer = `${FIREBASE_TOKEN_ISSUER_PREFIX}${projectId}`;
  if (payload.iss !== expectedIssuer) {
    throw new Error(`Invalid issuer: ${payload.iss}`);
  }

  if (payload.aud !== projectId) {
    throw new Error(`Invalid audience: ${payload.aud}`);
  }

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Missing or invalid subject (uid)");
  }

  return payload;
}
