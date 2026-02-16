#!/usr/bin/env node
/**
 * BotsChat Media Browser E2E Test
 * 
 * Tests the web UI media flow using browser automation:
 *   1. Navigate to app with dev_token URL param → auto-login
 *   2. Verify login succeeds (channel list visible)
 *   3. Upload an image via the UI (file input)
 *   4. Send message with image attachment
 *   5. Verify the image appears in the message list
 *
 * Prerequisite:
 *   - Chrome open with DevTools MCP running
 *   - Local dev server at http://localhost:8787
 *   - DEV_AUTH_SECRET=REDACTED_DEV_SECRET configured
 *
 * This test is designed to be run manually with the Chrome DevTools tools,
 * or can be adapted for CI by replacing the browser interaction with Puppeteer.
 *
 * Usage: node tests/media-browser-test.mjs [BASE_URL]
 */

const BASE_URL = process.argv[2] || "http://localhost:8787";
const SECRET = "REDACTED_DEV_SECRET";

console.log(`
╔══════════════════════════════════════════════════════════╗
║  BotsChat Media Browser E2E Test                         ║
║                                                          ║
║  This test uses the dev-auth URL parameter to bypass     ║
║  Google OAuth login. Open this URL in Chrome:            ║
║                                                          ║
║  ${BASE_URL}/?dev_token=${SECRET}
║                                                          ║
║  Then use the Chrome DevTools MCP tools to verify:       ║
║  1. Login auto-completes (sidebar shows channels)        ║
║  2. Select a channel                                     ║
║  3. Click the image upload button                        ║
║  4. Upload an image                                      ║
║  5. Send message with image                              ║
║  6. Image appears in message list                        ║
╚══════════════════════════════════════════════════════════╝

Test URL: ${BASE_URL}/?dev_token=${SECRET}
`);

// Pre-create test data via API for the browser test
async function setupTestData() {
  console.log("Setting up test data...");
  
  // Login
  const loginRes = await fetch(`${BASE_URL}/api/dev-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: SECRET }),
  });
  const { token, userId } = await loginRes.json();
  console.log(`  Logged in as ${userId}`);

  // Create a channel
  const chanRes = await fetch(`${BASE_URL}/api/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: `Browser Test ${Date.now()}` }),
  });
  const chan = await chanRes.json();
  console.log(`  Created channel: ${chan.name} (${chan.id})`);
  
  console.log("\nBrowser test data ready. Navigate to:");
  console.log(`  ${BASE_URL}/?dev_token=${SECRET}`);
  console.log("\nThe browser should auto-login and show the channel list.");
}

setupTestData().catch(console.error);
