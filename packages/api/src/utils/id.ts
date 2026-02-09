/**
 * Pick a uniformly random character from `chars` using rejection sampling.
 * Avoids modulo bias that occurs when 256 % chars.length !== 0.
 */
const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 chars
const CHARS_LEN = CHARS.length;
// Largest multiple of CHARS_LEN that fits in a byte (252 = 36 * 7)
const MAX_VALID = CHARS_LEN * Math.floor(256 / CHARS_LEN) - 1; // 251

function uniformRandomChars(count: number): string {
  let result = "";
  // Allocate extra bytes to reduce the chance of needing multiple rounds
  const buf = new Uint8Array(count + 16);
  let pos = 0;
  while (result.length < count) {
    crypto.getRandomValues(buf);
    for (pos = 0; pos < buf.length && result.length < count; pos++) {
      if (buf[pos] <= MAX_VALID) {
        result += CHARS[buf[pos] % CHARS_LEN];
      }
      // else: reject and continue (bias-free)
    }
  }
  return result;
}

/** Generate a short random ID (URL-safe) using CSPRNG. */
export function generateId(prefix = ""): string {
  return prefix + uniformRandomChars(16);
}

/** Generate a pairing token with bc_pat_ prefix using CSPRNG. */
export function generatePairingToken(): string {
  return "bc_pat_" + uniformRandomChars(32);
}
