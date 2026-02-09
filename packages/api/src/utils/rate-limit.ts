import type { MiddlewareHandler } from "hono";
import type { Env } from "../env.js";

/**
 * Simple in-memory sliding-window rate limiter for Cloudflare Workers.
 *
 * Note: Each CF Worker isolate has its own memory, so this is per-isolate.
 * For stronger guarantees, use Cloudflare Rate Limiting Rules in the Dashboard.
 * This middleware provides a best-effort defense against brute-force attacks.
 */

type RateLimitEntry = {
  timestamps: number[];
};

const store = new Map<string, RateLimitEntry>();

// Periodically clean up old entries to prevent memory leaks
let lastCleanup = Date.now();
function cleanup(windowMs: number): void {
  const now = Date.now();
  if (now - lastCleanup < windowMs) return;
  lastCleanup = now;
  const cutoff = now - windowMs;
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}

/**
 * Create a rate-limiting middleware.
 * @param maxRequests Maximum requests allowed in the window
 * @param windowMs Time window in milliseconds (default: 60_000 = 1 minute)
 */
export function rateLimit(
  maxRequests: number,
  windowMs = 60_000,
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    // Use CF-Connecting-IP (real client IP behind Cloudflare)
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      "unknown";

    const key = `${c.req.path}:${ip}`;
    const now = Date.now();
    const cutoff = now - windowMs;

    cleanup(windowMs);

    let entry = store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(key, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= maxRequests) {
      const retryAfter = Math.ceil((entry.timestamps[0] + windowMs - now) / 1000);
      return c.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    entry.timestamps.push(now);
    await next();
  };
}
