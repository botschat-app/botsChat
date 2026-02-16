import WebSocket from "ws";
import { deriveKey, encryptText, decryptText, toBase64, fromBase64 } from "../packages/e2e-crypto/e2e-crypto.js";

const E2E_PWD = process.env.TEST_E2E_PASSWORD || "";

async function main() {
  // Login
  const res = await fetch("http://localhost:8787/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "tong@mini.local", password: process.env.TEST_PASSWORD || "" }),
  });
  if (!res.ok) { console.log("Login failed:", res.status); process.exit(1); }
  const login = await res.json() as { id: string; token: string };
  const { token, id: userId } = login;
  console.log("1. Logged in:", userId);

  // Channels — create if none
  const chRes = await fetch("http://localhost:8787/api/channels", { headers: { Authorization: `Bearer ${token}` } });
  let { channels } = await chRes.json() as { channels: Array<{ id: string }> };
  if (!channels.length) {
    const cr = await fetch("http://localhost:8787/api/channels", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Channel", description: "E2E test" }),
    });
    const ch = await cr.json() as { id: string };
    channels = [ch];
    console.log("   Created channel:", ch.id);
  }

  // Sessions — create a fresh one
  const sesRes = await fetch(`http://localhost:8787/api/channels/${channels[0].id}/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "E2E Chat Test" }),
  });
  const session = await sesRes.json() as { sessionKey: string };
  console.log("2. Session:", session.sessionKey);

  // Derive key
  const key = await deriveKey(E2E_PWD, userId);
  console.log("3. E2E key derived");

  // WS connect
  const ws = new WebSocket(`ws://localhost:8787/api/ws/${userId}/chat-test`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error("Timeout 45s")); ws.close(); }, 45000);

    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));

    ws.on("message", async (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;

      if (msg.type === "auth.ok") {
        console.log("4. WS auth OK");
        const messageId = `chat-test-${Date.now()}`;
        const ct = await encryptText(key, "hello from API test", messageId);
        ws.send(JSON.stringify({
          type: "user.message",
          sessionKey: session.sessionKey,
          text: toBase64(ct),
          messageId,
          encrypted: true,
        }));
        console.log("5. Sent encrypted 'hello from API test'");
      }

      if (msg.type === "agent.text") {
        console.log(`6. Got agent.text (encrypted=${msg.encrypted}, messageId=${msg.messageId})`);
        if (msg.encrypted && msg.messageId) {
          try {
            const plain = await decryptText(key, fromBase64(msg.text as string), msg.messageId as string);
            console.log("   DECRYPTED:", plain.slice(0, 200));
          } catch (e: any) {
            console.log("   Decrypt FAILED:", e.message);
            console.log("   Raw:", (msg.text as string || "").slice(0, 80));
          }
        } else {
          console.log("   PLAINTEXT:", ((msg.text as string) || "").slice(0, 200));
        }
        clearTimeout(timeout);
        resolve();
        ws.close();
      }

      if (msg.type === "error") console.log("ERROR:", msg.message);
    });

    ws.on("error", (e) => console.log("WS error:", e.message));
  });

  console.log("\nTEST COMPLETE");
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
