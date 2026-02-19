/** Cloudflare Worker environment bindings */
export type Env = {
  DB: D1Database;
  MEDIA: R2Bucket;
  CONNECTION_DO: DurableObjectNamespace;
  ENVIRONMENT: string;
  JWT_SECRET?: string;
  FIREBASE_PROJECT_ID?: string;
  GOOGLE_WEB_CLIENT_ID?: string;
  GOOGLE_IOS_CLIENT_ID?: string;
  /** Canonical public URL override — if set, always use this as cloudUrl. */
  PUBLIC_URL?: string;
  /** Secret for dev-token auth bypass (automated testing). Endpoint is 404 when unset. */
  DEV_AUTH_SECRET?: string;
  /** FCM Service Account JSON for push notifications (stored as secret via `wrangler secret put`). */
  FCM_SERVICE_ACCOUNT_JSON?: string;
};
