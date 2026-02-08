import { Hono } from "hono";
import type { Env } from "../env.js";

export const upload = new Hono<{
  Bindings: Env;
  Variables: { userId: string };
}>();

/** POST / — Upload a file to R2 and return its public URL. */
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

  // Validate file type — only images allowed
  if (!file.type.startsWith("image/")) {
    return c.json({ error: "Only image files are allowed" }, 400);
  }

  // Limit file size to 10 MB
  const MAX_SIZE = 10 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    return c.json({ error: "File too large (max 10 MB)" }, 413);
  }

  // Generate a unique key: media/{userId}/{timestamp}-{random}.{ext}
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
  const safeExt = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"].includes(ext) ? ext : "png";
  const key = `media/${userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${safeExt}`;

  // Upload to R2
  await c.env.MEDIA.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type,
    },
  });

  // Return the URL for serving through the API
  const url = `/api/media/${key.replace("media/", "")}`;

  return c.json({ url, key });
});
