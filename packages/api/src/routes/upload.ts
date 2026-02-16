import { Hono } from "hono";
import type { Env } from "../env.js";
import { signMediaUrl, getJwtSecret } from "../utils/auth.js";
import { randomUUID } from "../utils/uuid.js";

export const upload = new Hono<{
  Bindings: Env;
  Variables: { userId: string };
}>();

/** Allowed non-image MIME types for file attachments. */
const ALLOWED_FILE_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm", "audio/aac",
  "video/mp4", "video/webm", "video/quicktime",
]);

/** Safe file extensions for each category. */
const SAFE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico",
  "pdf", "txt", "csv", "md", "json", "zip", "gz", "tar",
  "mp3", "wav", "ogg", "m4a", "aac", "webm",
  "mp4", "mov",
]);

/** POST / — Upload a file to R2 and return a signed URL. */
upload.post("/", async (c) => {
  try {
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

    const fileType = file.type || "";

    // Block SVG (XSS vector) and executables
    if (fileType.includes("svg") || fileType.includes("executable") || fileType.includes("javascript")) {
      return c.json({ error: "File type not permitted (SVG, executables, scripts are blocked)" }, 400);
    }

    // Allow images (except SVG) and a curated set of other file types
    const isImage = fileType.startsWith("image/");
    const isAllowedFile = ALLOWED_FILE_TYPES.has(fileType);
    if (!isImage && !isAllowedFile) {
      return c.json({ error: `File type '${fileType}' is not supported` }, 400);
    }

    // Limit file size to 10 MB
    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return c.json({ error: "File too large (max 10 MB)" }, 413);
    }

    // Generate a unique key: media/{userId}/{timestamp}-{random}.{ext}
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";
    const safeExt = SAFE_EXTENSIONS.has(ext) ? ext : (isImage ? "png" : "bin");
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${safeExt}`;
    const key = `media/${userId}/${filename}`;

    // Upload to R2
    await c.env.MEDIA.put(key, file.stream(), {
      httpMetadata: {
        contentType: fileType || "application/octet-stream",
      },
    });

    // Return a signed URL (1 hour expiry)
    const secret = getJwtSecret(c.env);
    const url = await signMediaUrl(userId, filename, secret, 3600);

    return c.json({ url, key });
  } catch (err) {
    console.error("[upload] Error:", err);
    return c.json({ error: `Upload failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
});
