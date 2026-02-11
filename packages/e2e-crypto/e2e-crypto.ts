/**
 * E2E Crypto — Isomorphic AES-256-CTR encryption with PBKDF2 key derivation.
 *
 * Works in both Web Crypto API (browser / Cloudflare Workers) and Node.js.
 *
 * Key design decisions:
 *   - Salt = "botschat-e2e:" + userId (domain-prefixed, deterministic)
 *   - PBKDF2-SHA256 with 310,000 iterations (OWASP 2023)
 *   - AES-256-CTR with nonce derived from contextId via HKDF-SHA256
 *   - Zero ciphertext overhead (no tag/MAC)
 *   - Each contextId MUST be globally unique and used ONLY ONCE per key
 */

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

const isNode =
  typeof globalThis.process !== "undefined" &&
  typeof globalThis.process.versions?.node === "string";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 310_000;
const KEY_LENGTH = 32; // 256 bits
const NONCE_LENGTH = 16; // AES-CTR counter block
const SALT_PREFIX = "botschat-e2e:";

// ---------------------------------------------------------------------------
// Helpers — encode / decode
// ---------------------------------------------------------------------------

function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function utf8Decode(buf: Uint8Array): string {
  return new TextDecoder().decode(buf);
}

// ---------------------------------------------------------------------------
// Web Crypto (browser + Cloudflare Workers) implementation
// ---------------------------------------------------------------------------

async function deriveKeyWeb(
  password: string,
  userId: string,
): Promise<Uint8Array> {
  const enc = utf8Encode(password);
  const salt = utf8Encode(SALT_PREFIX + userId);
  const baseKey = await crypto.subtle.importKey("raw", enc.buffer as ArrayBuffer, "PBKDF2", false, [
    "deriveBits",
  ]);
  const saltArr = new ArrayBuffer(salt.byteLength);
  new Uint8Array(saltArr).set(salt);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltArr, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    KEY_LENGTH * 8,
  );
  return new Uint8Array(bits);
}

/**
 * HKDF-SHA256 expand-only (single-step, info-only).
 * We only need 16 bytes so a single HMAC round suffices.
 */
async function hkdfNonceWeb(
  key: Uint8Array,
  contextId: string,
): Promise<Uint8Array> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    key.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const info = utf8Encode("nonce-" + contextId);
  // HKDF-Expand: T(1) = HMAC(PRK, info || 0x01)
  const input = new Uint8Array(info.length + 1);
  input.set(info);
  input[info.length] = 0x01;
  const full = await crypto.subtle.sign("HMAC", hmacKey, input.buffer as ArrayBuffer);
  return new Uint8Array(full).slice(0, NONCE_LENGTH);
}

async function encryptWeb(
  key: Uint8Array,
  plaintext: Uint8Array,
  contextId: string,
): Promise<Uint8Array> {
  const counter = await hkdfNonceWeb(key, contextId);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    key.buffer as ArrayBuffer,
    { name: "AES-CTR" },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: new Uint8Array(counter).buffer as ArrayBuffer, length: 128 },
    aesKey,
    plaintext.buffer as ArrayBuffer,
  );
  return new Uint8Array(ciphertext);
}

async function decryptWeb(
  key: Uint8Array,
  ciphertext: Uint8Array,
  contextId: string,
): Promise<Uint8Array> {
  const counter = await hkdfNonceWeb(key, contextId);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    key.buffer as ArrayBuffer,
    { name: "AES-CTR" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-CTR", counter: new Uint8Array(counter).buffer as ArrayBuffer, length: 128 },
    aesKey,
    ciphertext.buffer as ArrayBuffer,
  );
  return new Uint8Array(plaintext);
}

// ---------------------------------------------------------------------------
// Node.js implementation
// ---------------------------------------------------------------------------

async function deriveKeyNode(
  password: string,
  userId: string,
): Promise<Uint8Array> {
  const { pbkdf2 } = await import("node:crypto");
  const { promisify } = await import("node:util");
  const pbkdf2Async = promisify(pbkdf2);
  const salt = SALT_PREFIX + userId;
  const buf = await pbkdf2Async(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
  return new Uint8Array(buf);
}

async function hkdfNonceNode(
  key: Uint8Array,
  contextId: string,
): Promise<Uint8Array> {
  const { createHmac } = await import("node:crypto");
  const info = utf8Encode("nonce-" + contextId);
  const input = new Uint8Array(info.length + 1);
  input.set(info);
  input[info.length] = 0x01;
  const hmac = createHmac("sha256", Buffer.from(key));
  hmac.update(Buffer.from(input));
  const full = hmac.digest();
  return new Uint8Array(full.buffer, full.byteOffset, NONCE_LENGTH);
}

async function encryptNode(
  key: Uint8Array,
  plaintext: Uint8Array,
  contextId: string,
): Promise<Uint8Array> {
  const { createCipheriv } = await import("node:crypto");
  const iv = await hkdfNonceNode(key, contextId);
  const cipher = createCipheriv(
    "aes-256-ctr",
    Buffer.from(key),
    Buffer.from(iv),
  );
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return new Uint8Array(encrypted);
}

async function decryptNode(
  key: Uint8Array,
  ciphertext: Uint8Array,
  contextId: string,
): Promise<Uint8Array> {
  const { createDecipheriv } = await import("node:crypto");
  const iv = await hkdfNonceNode(key, contextId);
  const decipher = createDecipheriv(
    "aes-256-ctr",
    Buffer.from(key),
    Buffer.from(iv),
  );
  const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
  return new Uint8Array(decrypted);
}

// ---------------------------------------------------------------------------
// Public API — auto-selects implementation based on runtime
// ---------------------------------------------------------------------------

/**
 * Derive a 256-bit master key from the user's E2E password and userId.
 * Uses PBKDF2-SHA256 with 310,000 iterations; salt = "botschat-e2e:" + userId.
 */
export async function deriveKey(
  password: string,
  userId: string,
): Promise<Uint8Array> {
  return isNode ? deriveKeyNode(password, userId) : deriveKeyWeb(password, userId);
}

/**
 * Encrypt plaintext string using AES-256-CTR with a nonce derived from contextId.
 * Returns raw ciphertext bytes (same length as UTF-8 encoded plaintext).
 *
 * ⚠️  Each contextId MUST be globally unique and used ONLY ONCE per key.
 */
export async function encryptText(
  key: Uint8Array,
  plaintext: string,
  contextId: string,
): Promise<Uint8Array> {
  const data = utf8Encode(plaintext);
  return isNode
    ? encryptNode(key, data, contextId)
    : encryptWeb(key, data, contextId);
}

/**
 * Decrypt ciphertext bytes back to a plaintext string.
 * Returns the original UTF-8 string.
 *
 * Throws or returns garbled text if the key or contextId is wrong
 * (AES-CTR has no authentication — caller must handle errors gracefully).
 */
export async function decryptText(
  key: Uint8Array,
  ciphertext: Uint8Array,
  contextId: string,
): Promise<string> {
  const data = isNode
    ? await decryptNode(key, ciphertext, contextId)
    : await decryptWeb(key, ciphertext, contextId);
  return utf8Decode(data);
}

/**
 * Encrypt raw bytes using AES-256-CTR with a nonce derived from contextId.
 * Returns raw ciphertext bytes (same length as input).
 */
export async function encryptBytes(
  key: Uint8Array,
  plaintext: Uint8Array,
  contextId: string,
): Promise<Uint8Array> {
  return isNode
    ? encryptNode(key, plaintext, contextId)
    : encryptWeb(key, plaintext, contextId);
}

/**
 * Decrypt raw ciphertext bytes.
 * Returns the original plaintext bytes.
 */
export async function decryptBytes(
  key: Uint8Array,
  ciphertext: Uint8Array,
  contextId: string,
): Promise<Uint8Array> {
  return isNode
    ? await decryptNode(key, ciphertext, contextId)
    : await decryptWeb(key, ciphertext, contextId);
}

// ---------------------------------------------------------------------------
// Utility: base64 encode/decode for JSON transport
// ---------------------------------------------------------------------------

/** Encode binary to URL-safe base64 (no padding). */
export function toBase64(data: Uint8Array): string {
  // Works in both browser and Node
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

/** Decode base64 string to binary. */
export function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(b64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
