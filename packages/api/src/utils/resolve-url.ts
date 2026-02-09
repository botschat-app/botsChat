import type { Env } from "../env.js";

/**
 * Resolve the best "cloudUrl" for the OpenClaw plugin to connect back to.
 *
 * Priority (highest → lowest reachability):
 *   1. Explicit `PUBLIC_URL` env var              — admin override wins
 *   2. Official CF deployment host                → https://console.botschat.app
 *   3. Any *.workers.dev host                     → request origin
 *   4. Public hostname (not an IP, not localhost)  → request origin
 *   5. Public / non-RFC-1918 IP                   → request origin
 *   6. 10.x.x.x (large LAN)                      → request origin
 *   7. 172.16-31.x.x (medium LAN)                → request origin
 *   8. 192.168.x.x (small LAN)                   → request origin
 *   9. Loopback (127.x / localhost)               → request origin  (last resort)
 *
 * The function also returns `isLoopback` so callers can attach a warning.
 */
export function resolveCloudUrl(
  request: Request,
  env: Pick<Env, "PUBLIC_URL">,
): { cloudUrl: string; isLoopback: boolean } {
  // 1. Explicit override
  if (env.PUBLIC_URL) {
    return { cloudUrl: env.PUBLIC_URL.replace(/\/+$/, ""), isLoopback: false };
  }

  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();

  // 2. Official Cloudflare deployment → canonical domain
  const OFFICIAL_HOSTS = [
    "console.botschat.app",
    "botschat-api.auxtenwpc.workers.dev",
    "botschat.app",
    "www.botschat.app",
  ];
  if (OFFICIAL_HOSTS.includes(host)) {
    return { cloudUrl: "https://console.botschat.app", isLoopback: false };
  }

  // 3. Any *.workers.dev — it's a CF deployment, use its origin
  if (host.endsWith(".workers.dev")) {
    return { cloudUrl: url.origin, isLoopback: false };
  }

  // Determine if host is loopback
  const loopback = host === "localhost" || host.startsWith("127.");

  // For everything else (LAN IPs, public IPs, custom hostnames) use the
  // request origin as-is. The user already reached the server via this
  // address, so it's the most reliable URL we know.
  return { cloudUrl: url.origin, isLoopback: loopback };
}

/**
 * Resolve cloud URL for the /api/setup/init and onboarding page endpoints.
 *
 * Also returns alternative URLs the CLI / web UI can suggest when the primary
 * URL is loopback.
 */
export function resolveCloudUrlWithHints(
  request: Request,
  env: Pick<Env, "PUBLIC_URL">,
): { cloudUrl: string; isLoopback: boolean; hint?: string } {
  const result = resolveCloudUrl(request, env);

  if (result.isLoopback) {
    return {
      ...result,
      hint:
        "This URL (localhost) only works on this machine. " +
        "If your OpenClaw is on a different host, use its LAN IP instead, " +
        "e.g. http://192.168.x.x:8787",
    };
  }

  return result;
}
