import { deriveKey, encryptText, decryptText, toBase64, fromBase64 } from "../packages/e2e-crypto/e2e-crypto";
import assert from "assert";

async function run() {
  console.log("Starting E2E Encryption Verification...");
  
  const password = "my-secret-password";
  const userId = "user-123";
  
  // 1. Key Derivation (Simulate Plugin & Web)
  console.log("Testing Key Derivation...");
  const key1 = await deriveKey(password, userId);
  const key2 = await deriveKey(password, userId);
  
  // Check keys byte-equal
  assert.strictEqual(toBase64(new Uint8Array(key1)), toBase64(new Uint8Array(key2)), "Keys should be deterministic");
  console.log("✅ Key Derivation Successful (consistent)");

  // 2. Encrypt (Simulate Agent -> User)
  console.log("Testing Encryption (Agent -> User)...");
  const plaintext = "Hello Secret World";
  const messageId = "msg-123-uuid"; // Context ID
  
  const encryptedBytes = await encryptText(key1, plaintext, messageId);
  const ciphertextBase64 = toBase64(encryptedBytes);
  console.log("Ciphertext (Base64):", ciphertextBase64);
  
  assert.notEqual(ciphertextBase64, plaintext, "Ciphertext should not match plaintext");
  console.log("✅ Encryption Successful");

  // 3. Decrypt (Simulate User -> Agent)
  console.log("Testing Decryption (User -> Agent)...");
  const decryptedText = await decryptText(key2, fromBase64(ciphertextBase64), messageId);
  console.log("Decrypted:", decryptedText);
  assert.strictEqual(decryptedText, plaintext, "Decrypted text MUST match original");
  console.log("✅ Decryption Successful");

  // 4. Test Task Encryption (Random IV flow)
  console.log("Testing Task Encryption (Random IV)...");
  const ivStr = "random-uuid-iv";
  const schedule = "0 * * * *";
  const encScheduleBytes = await encryptText(key1, schedule, ivStr);
  const encScheduleBase64 = toBase64(encScheduleBytes);
  
  const originalScheduleText = await decryptText(key2, fromBase64(encScheduleBase64), ivStr);
  
  assert.strictEqual(originalScheduleText, schedule);
  console.log("✅ Task Encryption/Decryption Successful");

  console.log("🎉 All Checks Passed!");
}

run().catch(err => {
  console.error("❌ Verification Failed:", err);
  process.exit(1);
});
