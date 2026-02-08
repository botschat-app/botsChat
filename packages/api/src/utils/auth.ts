import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env.js";

// Simple JWT-like token using HMAC-SHA256.
// In production, use a proper JWT library or Cloudflare Access.

type TokenPayload = {
  sub: string; // user ID
  exp: number; // expiration timestamp (seconds)
};

const ENCODER = new TextEncoder();

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

function base64UrlEncode(obj: unknown): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str: string): unknown {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(padded));
}

export async function createToken(
  userId: string,
  secret: string,
  expiresInSeconds = 86400 * 7, // 7 days
): Promise<string> {
  const payload: TokenPayload = {
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  };
  const header = base64UrlEncode({ alg: "HS256", typ: "JWT" });
  const body = base64UrlEncode(payload);
  const signature = await hmacSign(secret, `${header}.${body}`);
  return `${header}.${body}.${signature}`;
}

export async function verifyToken(
  token: string,
  secret: string,
): Promise<TokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const expected = await hmacSign(secret, `${header}.${body}`);
  if (signature !== expected) return null;

  const payload = base64UrlDecode(body) as TokenPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

/** Hash a password using SHA-256 (for simplicity; production should use bcrypt/scrypt). */
export async function hashPassword(password: string): Promise<string> {
  const data = ENCODER.encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Auth middleware: extracts user ID from Bearer token and sets it on context. */
export function authMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: { userId: string } }> {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.slice(7);
    const secret = c.env.JWT_SECRET ?? "botschat-dev-secret";
    const payload = await verifyToken(token, secret);

    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    c.set("userId", payload.sub);
    await next();
  };
}
