import { deriveKey, encryptText, decryptText, toBase64, fromBase64 } from "e2e-crypto";

const STORAGE_KEY = "botschat_e2e_pwd_cache"; // Stores encrypted password? Or password itself?
// For MVP, plan says: "Remember on this device" -> store password in localStorage (implicit risk acceptable for user convenience).
// Actually, storing password in localStorage is common for "Remember Me" if we don't have better key storage.
// We can store a hash? No, we need the password to derive the key.
// So we store the password.

let currentKey: Uint8Array | null = null;
let currentPassword: string | null = null;
const listeners: Set<() => void> = new Set();

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
   * Optionally persist the password to localStorage.
   */
  async setPassword(password: string, userId: string, remember: boolean): Promise<void> {
    if (!password) {
      currentKey = null;
      currentPassword = null;
      localStorage.removeItem(STORAGE_KEY);
      this.notify();
      return;
    }

    try {
      currentKey = await deriveKey(password, userId);
      currentPassword = password;
      if (remember) {
        localStorage.setItem(STORAGE_KEY, password);
      } else {
        localStorage.removeItem(STORAGE_KEY);
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
   * Try to load the password from storage and derive key.
   */
  async loadSavedPassword(userId: string): Promise<boolean> {
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
    // decryptText returns string; re-encode to bytes
    const plainStr = await decryptText(currentKey, ciphertext, messageId);
    return new TextEncoder().encode(plainStr);
  }
};
