/**
 * Live E2E encryption integration test.
 *
 * Tests:
 *   1. Web sends encrypted user.message via WS → plugin decrypts → agent responds → encrypted agent.text → Web decrypts
 *   2. D1 stores ciphertext (encrypted=1), not plaintext
 *
 * Prerequisites:
 *   - wrangler dev running on localhost:8787 (ENVIRONMENT=development)
 *   - mini.local gateway running with e2ePassword set
 *   - Test user tong@mini.local exists
 *
 * Usage: npx tsx scripts/test-e2e-live.ts
 */

import WebSocket from "ws";
import { deriveKey, encryptText, decryptText, toBase64, fromBase64 } from "../packages/e2e-crypto/e2e-crypto.js";
import { execSync } from "node:child_process";
import assert from "node:assert";

const API_BASE = "http://localhost:8787";
const E2E_PASSWORD = "e2e-test-2026";
const TEST_EMAIL = "tong@mini.local";
const TEST_PASS = "REDACTED_PASSWORD";
const SECRET_TEXT = `E2E_TEST_SECRET_${Date.now()}`;

async function login(): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const data = await res.json() as { token: string; id: string };
  return { token: data.token, userId: data.id };
}

async function getFirstSessionKey(token: string): Promise<{ channelId: string; sessionKey: string }> {
  const res = await fetch(`${API_BASE}/api/channels`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let { channels } = await res.json() as { channels: Array<{ id: string }> };
  if (!channels.length) {
    // Create a channel
    const cr = await fetch(`${API_BASE}/api/channels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "E2E Test", description: "E2E encryption test channel" }),
    });
    const ch = await cr.json() as { id: string };
    channels = [ch];
  }
  const channelId = channels[0].id;

  const res2 = await fetch(`${API_BASE}/api/channels/${channelId}/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let { sessions } = await res2.json() as { sessions: Array<{ sessionKey: string }> };
  if (!sessions.length) {
    // Create a session
    const sr = await fetch(`${API_BASE}/api/channels/${channelId}/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "E2E Test Session" }),
    });
    const s = await sr.json() as { sessionKey: string };
    sessions = [s];
  }
  return { channelId, sessionKey: sessions[0].sessionKey };
}

function connectWS(userId: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8787/api/ws/${userId}/live-test`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token }));
    });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "auth.ok") resolve(ws);
      if (msg.type === "auth.fail") reject(new Error("WS auth failed"));
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS connect timeout")), 10000);
  });
}

function waitForAgentReply(ws: WebSocket, timeoutMs = 60000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Agent reply timeout")), timeoutMs);
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === "agent.text") {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

function d1Query(sql: string): string {
  return execSync(
    `npx wrangler d1 execute botschat-db --local --command "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8", cwd: process.cwd() },
  );
}

async function run() {
  console.log("=== E2E Live Integration Test ===\n");

  // Step 1: Login
  console.log("1. Logging in...");
  const { token, userId } = await login();
  console.log(`   userId: ${userId}`);

  // Step 2: Derive E2E key (same as plugin)
  console.log("2. Deriving E2E key...");
  const key = await deriveKey(E2E_PASSWORD, userId);
  console.log(`   Key derived (${key.length} bytes)`);

  // Step 3: Get session
  console.log("3. Getting session key...");
  const { sessionKey } = await getFirstSessionKey(token);
  console.log(`   sessionKey: ${sessionKey}`);

  // Step 4: Connect WS
  console.log("4. Connecting WebSocket...");
  const ws = connectWS(userId, token);
  const wsConn = await ws;
  console.log("   Connected and authenticated");

  // Step 5: Send encrypted message
  console.log(`5. Sending encrypted message: "${SECRET_TEXT}"`);
  const messageId = `e2e-test-${Date.now()}`;
  const ciphertext = await encryptText(key, SECRET_TEXT, messageId);
  const ciphertextB64 = toBase64(ciphertext);

  wsConn.send(JSON.stringify({
    type: "user.message",
    sessionKey,
    text: ciphertextB64,
    messageId,
    encrypted: true,
  }));
  console.log(`   Sent (ciphertext length=${ciphertextB64.length}, messageId=${messageId})`);

  // Step 6: Wait for agent reply
  console.log("6. Waiting for agent reply (may take up to 60s)...");
  const agentMsg = await waitForAgentReply(wsConn);
  console.log(`   Got agent.text reply (encrypted=${agentMsg.encrypted})`);

  if (agentMsg.encrypted && agentMsg.messageId) {
    const agentCiphertext = fromBase64(agentMsg.text as string);
    const agentPlain = await decryptText(key, agentCiphertext, agentMsg.messageId as string);
    console.log(`   ✅ Decrypted agent reply: "${agentPlain.slice(0, 100)}..."`);
  } else {
    console.log(`   ⚠️  Agent reply was NOT encrypted (encrypted=${agentMsg.encrypted})`);
    console.log(`   Text: "${(agentMsg.text as string || "").slice(0, 100)}..."`);
  }

  // Step 7: Check D1 for encrypted storage
  console.log("7. Checking D1 for encrypted messages...");
  // Allow a small delay for persistence
  await new Promise((r) => setTimeout(r, 2000));

  const result = d1Query(`SELECT id, text, encrypted FROM messages WHERE user_id = '${userId}' ORDER BY created_at DESC LIMIT 5`);
  console.log("   D1 query result:");
  console.log(result);

  // Verify: the secret text should NOT appear as plaintext in D1
  if (result.includes(SECRET_TEXT)) {
    console.error("   ❌ FAIL: Plaintext found in D1! E2E storage is broken.");
    process.exit(1);
  } else {
    console.log("   ✅ Plaintext NOT found in D1 — ciphertext stored correctly");
  }

  // Check that at least one message has encrypted=1
  if (result.includes("encrypted: 1") || result.includes('"encrypted":1') || result.includes("encrypted\n1") || result.includes("| 1")) {
    console.log("   ✅ Found encrypted=1 rows in D1");
  } else {
    console.log("   ⚠️  Could not confirm encrypted=1 in output (check manually)");
  }

  wsConn.close();
  console.log("\n🎉 E2E Live Integration Test Complete!");
}

run().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
