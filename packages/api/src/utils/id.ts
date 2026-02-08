/** Generate a short random ID (URL-safe). */
export function generateId(prefix = ""): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = prefix;
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/** Generate a pairing token with bc_pat_ prefix. */
export function generatePairingToken(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "bc_pat_";
  for (let i = 0; i < 32; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}
