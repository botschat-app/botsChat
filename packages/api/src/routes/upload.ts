import { Hono } from "hono";
import type { Env } from "../env.js";
import { signMediaUrl, getJwtSecret } from "../utils/auth.js";
import { randomUUID } from "../utils/uuid.js";

export const upload = new Hono<{
  Bindings: Env;
  Variables: { userId: string };
}>();

/** POST / — Upload a file to R2 and return a signed URL. */
upload.post("/", async (c) => {
  const userId = c.get("userId");
  const contentType = c.req.header("Content-Type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "Expected multipart/form-data" }, 400);
  }

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return c.json({ error: "No file provided" }, 400);
  }

  // Validate file type — only raster images allowed (SVG is an XSS vector)
  if (!file.type.startsWith("image/") || file.type.includes("svg")) {
    return c.json({ error: "Only image files are allowed (SVG is not permitted)" }, 400);
  }

  // Limit file size to 10 MB
  const MAX_SIZE = 10 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    return c.json({ error: "File too large (max 10 MB)" }, 413);
  }

  // Generate a unique key: media/{userId}/{timestamp}-{random}.{ext}
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
  // SVG is excluded — it can contain <script> tags and is a known XSS vector
  const safeExt = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico"].includes(ext) ? ext : "png";
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${safeExt}`;
  const key = `media/${userId}/${filename}`;

  // Upload to R2
  await c.env.MEDIA.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type,
    },
  });

  // Return a signed URL (1 hour expiry)
  const secret = getJwtSecret(c.env);
  const url = await signMediaUrl(userId, filename, secret, 3600);

  return c.json({ url, key });
});
