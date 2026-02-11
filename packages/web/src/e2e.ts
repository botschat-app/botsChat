import { deriveKey, encryptText, decryptText, toBase64, fromBase64 } from "e2e-crypto";

const STORAGE_KEY = "botschat_e2e_pwd_cache";
const KEY_CACHE_KEY = "botschat_e2e_key_cache"; // base64-encoded derived key

let currentKey: Uint8Array | null = null;
let currentPassword: string | null = null;
const listeners: Set<() => void> = new Set();

// Try to restore cached key immediately (synchronous, no PBKDF2)
try {
  const cachedKey = localStorage.getItem(KEY_CACHE_KEY);
  if (cachedKey) {
    currentKey = fromBase64(cachedKey);
    currentPassword = localStorage.getItem(STORAGE_KEY);
  }
} catch { /* ignore */ }

export const E2eService = {
  /**
   * Subscribe to key state changes. Returns unsubscribe function.
   */
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  /**
   * Notify all listeners.
   */
  notify() {
    listeners.forEach((cb) => cb());
  },

  /**
   * Set the E2E password and derive the key.
   * Optionally persist the password and derived key to localStorage.
   */
  async setPassword(password: string, userId: string, remember: boolean): Promise<void> {
    if (!password) {
      currentKey = null;
      currentPassword = null;
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(KEY_CACHE_KEY);
      this.notify();
      return;
    }

    try {
      currentKey = await deriveKey(password, userId);
      currentPassword = password;
      if (remember) {
        localStorage.setItem(STORAGE_KEY, password);
        localStorage.setItem(KEY_CACHE_KEY, toBase64(currentKey));
      } else {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(KEY_CACHE_KEY);
      }
      this.notify();
    } catch (err) {
      console.error("Failed to derive E2E key:", err);
      throw err;
    }
  },

  /**
   * Clear the key and password from memory and storage.
   */
  clear(): void {
    currentKey = null;
    currentPassword = null;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(KEY_CACHE_KEY);
    this.notify();
  },

  /**
   * Check if we have a key loaded.
   */
  hasKey(): boolean {
    return !!currentKey;
  },

  /**
   * Check if we have a saved password in storage.
   */
  hasSavedPassword(): boolean {
    return !!localStorage.getItem(STORAGE_KEY);
  },

  /**
   * Try to load the key from cache or derive from saved password.
   * Cache path is synchronous (already done at module load).
   * Derive path is async (PBKDF2).
   */
  async loadSavedPassword(userId: string): Promise<boolean> {
    // Already loaded from cache at module init
    if (currentKey) return true;
    const pwd = localStorage.getItem(STORAGE_KEY);
    if (!pwd) return false;
    try {
      await this.setPassword(pwd, userId, true);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Encrypt text using the current key.
   * Generates a random messageId (UUID) as contextId/nonce source.
   * Returns { ciphertext: base64, messageId: string }
   */
  async encrypt(text: string): Promise<{ ciphertext: string; messageId: string }> {
    if (!currentKey) throw new Error("E2E key not set");
    const messageId = crypto.randomUUID();
    const encrypted = await encryptText(currentKey, text, messageId);
    return { ciphertext: toBase64(encrypted), messageId };
  },

  /**
   * Decrypt text (base64) using the current key and messageId (contextId).
   */
  async decrypt(ciphertextBase64: string, messageId: string): Promise<string> {
    if (!currentKey) throw new Error("E2E key not set");
    const ciphertext = fromBase64(ciphertextBase64);
    return decryptText(currentKey, ciphertext, messageId);
  },

  /**
   * Get the current E2E password (in memory). Returns null if not set.
   */
  getPassword(): string | null {
    return currentPassword;
  },

  /**
   * Decrypt bytes (base64) -> Uint8Array.
   */
  async decryptBytes(ciphertextBase64: string, messageId: string): Promise<Uint8Array> {
    if (!currentKey) throw new Error("E2E key not set");
    const ciphertext = fromBase64(ciphertextBase64);
    const plainStr = await decryptText(currentKey, ciphertext, messageId);
    return new TextEncoder().encode(plainStr);
  }
};
