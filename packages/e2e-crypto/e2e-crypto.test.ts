/**
 * E2E Crypto tests — CRYPTO-1 through CRYPTO-6 from docs/e2e-encryption-plan.md
 * Run: npx tsx packages/e2e-crypto/e2e-crypto.test.ts
 */

import assert from "node:assert";
import {
  deriveKey,
  encryptText,
  decryptText,
  encryptBytes,
  decryptBytes,
  toBase64,
  fromBase64,
} from "./e2e-crypto.js";

const password = "test-password";
const userId = "u_test_user_123";

async function testKeyDerivation() {
  const key1 = await deriveKey(password, userId);
  const key2 = await deriveKey(password, userId);
  assert.strictEqual(key1.length, 32, "Key must be 32 bytes");
  assert.strictEqual(
    toBase64(key1),
    toBase64(key2),
    "CRYPTO-1: Same password+userId must yield same key"
  );
  console.log("  ✅ CRYPTO-1 deriveKey(password, userId) consistent");
}

async function testRoundtrip() {
  const key = await deriveKey(password, userId);
  const plaintext = "Hello 世界 🔐";
  const contextId = "msg-abc-123";
  const ciphertext = await encryptText(key, plaintext, contextId);
  const decrypted = await decryptText(key, ciphertext, contextId);
  assert.strictEqual(
    decrypted,
    plaintext,
    "CRYPTO-2: decrypt(encrypt(plaintext)) === plaintext"
  );
  console.log("  ✅ CRYPTO-2 encrypt/decrypt roundtrip");
}

async function testCiphertextFormatAndLength() {
  const key = await deriveKey(password, userId);
  const plaintext = "short";
  const contextId = "ctx-1";
  const ciphertext = await encryptText(key, plaintext, contextId);
  const plainBytes = new TextEncoder().encode(plaintext);
  assert.strictEqual(
    ciphertext.length,
    plainBytes.length,
    "CRYPTO-3: Ciphertext length must equal plaintext length (no prefix, no expansion)"
  );
  assert.ok(
    ciphertext.length > 0 && !Buffer.from(ciphertext).toString("utf8").startsWith("e2e:"),
    "CRYPTO-3: No business prefix"
  );
  console.log("  ✅ CRYPTO-3 ciphertext format and length");
}

async function testWrongKeyOrContextIdFails() {
  const key = await deriveKey(password, userId);
  const plaintext = "secret";
  const contextId = "msg-1";
  const ciphertext = await encryptText(key, plaintext, contextId);

  const wrongKey = await deriveKey("wrong-password", userId);
  let decryptedWrongKey = "";
  try {
    decryptedWrongKey = await decryptText(wrongKey, ciphertext, contextId);
  } catch {
    // Expected: decrypt may throw or return garbage
  }
  assert.notStrictEqual(
    decryptedWrongKey,
    plaintext,
    "CRYPTO-4: Wrong key must not produce original plaintext"
  );

  let decryptedWrongCtx = "";
  try {
    decryptedWrongCtx = await decryptText(key, ciphertext, "wrong-context-id");
  } catch {
    // Expected
  }
  assert.notStrictEqual(
    decryptedWrongCtx,
    plaintext,
    "CRYPTO-4: Wrong contextId must not produce original plaintext"
  );
  console.log("  ✅ CRYPTO-4 wrong key/contextId does not reveal plaintext");
}

async function testDeterministicSameContextId() {
  const key = await deriveKey(password, userId);
  const plaintext = "same";
  const contextId = "ctx-deterministic";
  const ct1 = await encryptText(key, plaintext, contextId);
  const ct2 = await encryptText(key, plaintext, contextId);
  assert.strictEqual(
    toBase64(ct1),
    toBase64(ct2),
    "CRYPTO-5: Same plaintext + contextId must yield same ciphertext"
  );
  console.log("  ✅ CRYPTO-5 deterministic encryption for same contextId");
}

async function testShortPlaintextZeroExpansion() {
  const key = await deriveKey(password, userId);
  const plaintext = "ab"; // 2 bytes UTF-8
  const contextId = "msg-2bytes";
  const ciphertext = await encryptText(key, plaintext, contextId);
  assert.strictEqual(
    ciphertext.length,
    2,
    "CRYPTO-6: 2-byte plaintext must produce 2-byte ciphertext (zero expansion)"
  );
  const decrypted = await decryptText(key, ciphertext, contextId);
  assert.strictEqual(decrypted, plaintext);
  console.log("  ✅ CRYPTO-6 short plaintext zero expansion");
}

async function testBytesRoundtrip() {
  const key = await deriveKey(password, userId);
  const raw = new Uint8Array([0x00, 0x01, 0xff, 0xfe]);
  const contextId = "bytes-1";
  const ct = await encryptBytes(key, raw, contextId);
  assert.strictEqual(ct.length, raw.length);
  const dec = await decryptBytes(key, ct, contextId);
  assert.strictEqual(dec.length, raw.length);
  for (let i = 0; i < raw.length; i++) assert.strictEqual(dec[i], raw[i]);
  console.log("  ✅ encryptBytes/decryptBytes roundtrip");
}

async function run() {
  console.log("E2E Crypto test suite\n");
  await testKeyDerivation();
  await testRoundtrip();
  await testCiphertextFormatAndLength();
  await testWrongKeyOrContextIdFails();
  await testDeterministicSameContextId();
  await testShortPlaintextZeroExpansion();
  await testBytesRoundtrip();
  console.log("\n🎉 All E2E crypto tests passed.");
}

run().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
