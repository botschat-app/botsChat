/** Cloudflare Worker environment bindings */
export type Env = {
  DB: D1Database;
  MEDIA: R2Bucket;
  CONNECTION_DO: DurableObjectNamespace;
  ENVIRONMENT: string;
  JWT_SECRET?: string;
};
