import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env.js";
import { SignJWT, jwtVerify } from "jose";

// JWT implementation using the `jose` library (timing-safe, standards-compliant).

type TokenPayload = {
  sub: string; // user ID
  exp: number; // expiration timestamp (seconds)
};

const ENCODER = new TextEncoder();

/** Derive a CryptoKey from a string secret for HMAC-SHA256. */
function getSecretKey(secret: string): Uint8Array {
  return ENCODER.encode(secret);
}

/** Create a short-lived access token (default 30 minutes). */
export async function createToken(
  userId: string,
  secret: string,
  expiresInSeconds = 1800, // 30 minutes
): Promise<string> {
  return new SignJWT({ sub: userId, type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("botschat")
    .setExpirationTime(`${expiresInSeconds}s`)
    .sign(getSecretKey(secret));
}

/** Create a long-lived refresh token (default 7 days). */
export async function createRefreshToken(
  userId: string,
  secret: string,
  expiresInSeconds = 86400 * 7, // 7 days
): Promise<string> {
  return new SignJWT({ sub: userId, type: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("botschat")
    .setExpirationTime(`${expiresInSeconds}s`)
    .sign(getSecretKey(secret));
}

/** Verify a refresh token and return the payload. */
export async function verifyRefreshToken(
  token: string,
  secret: string,
): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(secret), {
      issuer: "botschat",
    });
    if (!payload.sub) return null;
    // Must be a refresh token
    if (payload.type !== "refresh") return null;
    return { sub: payload.sub, exp: payload.exp ?? 0 };
  } catch {
    return null;
  }
}

export async function verifyToken(
  token: string,
  secret: string,
): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(secret), {
      issuer: "botschat",
    });
    if (!payload.sub) return null;
    return { sub: payload.sub, exp: payload.exp ?? 0 };
  } catch {
    // Also try verifying without issuer check for backward compatibility
    // with tokens issued before this migration
    try {
      const { payload } = await jwtVerify(token, getSecretKey(secret));
      if (!payload.sub) return null;
      return { sub: payload.sub, exp: payload.exp ?? 0 };
    } catch {
      return null;
    }
  }
}

// HMAC-SHA256 signing for non-JWT purposes (media URL signing)
async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, ENCODER.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---- Password hashing (PBKDF2 with migration support) ----

const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 recommendation
const SALT_LENGTH = 16; // 128-bit salt

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Check if a stored hash is the legacy SHA-256 format (64-char hex string). */
function isLegacyHash(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash);
}

/** Legacy SHA-256 hash (for migration comparison only). */
async function legacySha256(password: string): Promise<string> {
  const data = ENCODER.encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash);
}

/** Hash a password using PBKDF2-SHA256 with a random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  const saltHex = toHex(salt.buffer);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const hashHex = toHex(derived);

  return `pbkdf2:${PBKDF2_ITERATIONS}:${saltHex}:${hashHex}`;
}

/**
 * Verify a password against a stored hash (supports both PBKDF2 and legacy SHA-256).
 * Returns { valid, needsRehash } — if needsRehash is true, the caller should
 * update the stored hash to the new PBKDF2 format.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<{ valid: boolean; needsRehash: boolean }> {
  // Legacy SHA-256 format: 64-char hex
  if (isLegacyHash(storedHash)) {
    const computed = await legacySha256(password);
    return { valid: computed === storedHash, needsRehash: true };
  }

  // PBKDF2 format: pbkdf2:<iterations>:<salt>:<hash>
  const parts = storedHash.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") {
    return { valid: false, needsRehash: false };
  }

  const [, iterStr, saltHex, expectedHash] = parts;
  const iterations = parseInt(iterStr, 10);
  const salt = fromHex(saltHex);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const computedHash = toHex(derived);

  const valid = computedHash === expectedHash;
  // If using fewer iterations than current standard, suggest rehash
  const needsRehash = valid && iterations < PBKDF2_ITERATIONS;
  return { valid, needsRehash };
}

/**
 * Get the JWT secret from environment, throwing a clear error if not set.
 * In development (wrangler dev), falls back to a dev-only secret.
 */
export function getJwtSecret(env: Env): string {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (env.ENVIRONMENT === "development") return "botschat-dev-secret-local-only";
  throw new Error("JWT_SECRET environment variable is not set. Configure it via `wrangler secret put JWT_SECRET`.");
}

/** Auth middleware: extracts user ID from Bearer token and sets it on context. */
export function authMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: { userId: string } }> {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.slice(7);
    const secret = getJwtSecret(c.env);
    const payload = await verifyToken(token, secret);

    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    c.set("userId", payload.sub);
    await next();
  };
}

// ---- Signed media URLs ----

/**
 * Generate a signed media URL path with expiry.
 * Format: /api/media/:userId/:filename?expires=<ts>&sig=<hex>
 */
export async function signMediaUrl(
  userId: string,
  filename: string,
  secret: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const data = `${userId}/${filename}:${expires}`;
  const sig = await hmacSign(secret, data);
  return `/api/media/${userId}/${encodeURIComponent(filename)}?expires=${expires}&sig=${encodeURIComponent(sig)}`;
}

/**
 * Verify a signed media URL.
 * Returns true if the signature is valid and the URL has not expired.
 */
export async function verifyMediaSignature(
  userId: string,
  filename: string,
  expires: string,
  sig: string,
  secret: string,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const expiresNum = parseInt(expires, 10);
  if (isNaN(expiresNum) || expiresNum < now) return false;

  const data = `${userId}/${filename}:${expires}`;
  const expected = await hmacSign(secret, data);
  return sig === expected;
}
