/** Cloudflare Worker environment bindings */
export type Env = {
  DB: D1Database;
  MEDIA: R2Bucket;
  CONNECTION_DO: DurableObjectNamespace;
  ENVIRONMENT: string;
  JWT_SECRET?: string;
  FIREBASE_PROJECT_ID?: string;
  /** Canonical public URL override — if set, always use this as cloudUrl. */
  PUBLIC_URL?: string;
};
