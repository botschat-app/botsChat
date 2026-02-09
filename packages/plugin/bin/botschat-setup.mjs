#!/usr/bin/env node

/**
 * botschat-setup — Interactive CLI to connect your OpenClaw to BotsChat.
 *
 * Usage:
 *   botschat-setup                                     # Interactive mode
 *   botschat-setup --url https://console.botschat.app --token bc_pat_xxx   # Non-interactive
 *   botschat-setup --url https://console.botschat.app --email me@x.com --password xxx
 */

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_URL = "https://console.botschat.app";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

/** Check if URL is loopback (localhost / 127.x) */
function isLoopbackUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname.startsWith("127.");
  } catch {
    return false;
  }
}

function prompt(rl, question, defaultValue) {
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function promptPassword(rl, question) {
  return new Promise((resolve) => {
    // Use raw mode to hide password input
    process.stdout.write(`  ${question}: `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    let password = "";
    const onData = (ch) => {
      const c = ch.toString("utf8");
      if (c === "\n" || c === "\r" || c === "\u0004") {
        if (stdin.setRawMode) stdin.setRawMode(wasRaw);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(password);
      } else if (c === "\u0003") {
        // Ctrl+C
        process.exit(1);
      } else if (c === "\u007f" || c === "\b") {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        password += c;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

function runOpenclaw(args) {
  const PATH = process.env.PATH || "";
  const env = { ...process.env, PATH: `/opt/homebrew/bin:${PATH}` };
  try {
    execFileSync("openclaw", args, { env, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function checkConnection(baseUrl, token, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const resp = await fetch(`${baseUrl}/api/setup/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.connected) return true;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || args.h) {
    console.log(`
  botschat-setup — Connect your OpenClaw to BotsChat

  Usage:
    botschat-setup                                        Interactive setup
    botschat-setup --token bc_pat_xxx                     Use existing token
    botschat-setup --email me@x.com --password xxx        Login and setup
    botschat-setup --url https://console.botschat.app --token ... Custom server

  Options:
    --url       BotsChat server URL (default: ${DEFAULT_URL})
    --token     Pairing token (bc_pat_xxx)
    --email     Email for login (creates pairing token automatically)
    --password  Password for login
    --help      Show this help
`);
    process.exit(0);
  }

  console.log();
  console.log("  BotsChat Setup");
  console.log("  ─────────────────────────────────────────");
  console.log();

  let cloudUrl = args.url || "";
  let pairingToken = args.token || "";
  let jwtToken = "";

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    // ---- Step 1: Get cloud URL ----
    if (!cloudUrl) {
      cloudUrl = await prompt(rl, "BotsChat URL", DEFAULT_URL);
    }
    // Normalize: strip trailing slash
    cloudUrl = cloudUrl.replace(/\/+$/, "");

    // ---- Step 2: Get pairing token (direct or via login) ----
    if (!pairingToken) {
      if (args.email && args.password) {
        // Non-interactive login
        console.log(`  Logging in as ${args.email}...`);
        const resp = await fetch(`${cloudUrl}/api/setup/init`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: args.email, password: args.password }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          console.error(`  Error: ${err.error || `HTTP ${resp.status}`}`);
          process.exit(1);
        }
        const data = await resp.json();
        pairingToken = data.pairingToken;
        jwtToken = data.token;
        console.log(`  Authenticated as ${data.email}`);
      } else {
        // Ask: do you have a token, or login?
        console.log("  How would you like to authenticate?");
        console.log("    1) I have a pairing token (from the BotsChat web UI)");
        console.log("    2) Login with email and password");
        console.log();
        const choice = await prompt(rl, "Choice", "1");

        if (choice === "2") {
          const email = await prompt(rl, "Email", "");
          const password = await promptPassword(rl, "Password");

          console.log("  Logging in...");
          const resp = await fetch(`${cloudUrl}/api/setup/init`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            console.error(`  Error: ${err.error || `HTTP ${resp.status}`}`);
            process.exit(1);
          }
          const data = await resp.json();
          pairingToken = data.pairingToken;
          jwtToken = data.token;
          console.log(`  Authenticated as ${data.email}`);
        } else {
          pairingToken = await prompt(rl, "Pairing token (bc_pat_...)", "");
          if (!pairingToken) {
            console.error("  Error: Pairing token is required");
            process.exit(1);
          }
        }
      }
    }

    // ---- Step 2.5: Smart URL resolution — prefer the API's recommendation ----
    // The /api/setup/init response's cloudUrl is resolved by the backend.
    // But if we logged in, also check the cloudUrlWarning.
    // If the URL is loopback and user hasn't explicitly chosen it, warn.
    if (isLoopbackUrl(cloudUrl)) {
      console.log();
      console.log("  \x1b[33m⚠  Warning:\x1b[0m The cloud URL is \x1b[1m" + cloudUrl + "\x1b[0m (localhost).");
      console.log("     This only works if OpenClaw is on the same machine.");
      console.log("     If OpenClaw is on another host, use a LAN IP instead,");
      console.log("     e.g. http://192.168.x.x:8787 or http://10.x.x.x:8787");
      console.log();
      const override = await prompt(rl, "Cloud URL (press Enter to keep, or type new URL)", cloudUrl);
      if (override && override !== cloudUrl) {
        cloudUrl = override.replace(/\/+$/, "");
      }
    }

    // If the API returned a cloudUrlWarning (e.g. via login), the URL was
    // already chosen in step 2. Try to resolve a better URL via /api/setup/cloud-url.
    try {
      const cuResp = await fetch(`${cloudUrl}/api/setup/cloud-url`);
      if (cuResp.ok) {
        const cuData = await cuResp.json();
        if (cuData.cloudUrl && cuData.cloudUrl !== cloudUrl && !isLoopbackUrl(cuData.cloudUrl)) {
          console.log(`  Server recommends: ${cuData.cloudUrl}`);
          const useRecommended = await prompt(rl, `Use ${cuData.cloudUrl} instead? [Y/n]`, "Y");
          if (!useRecommended || useRecommended.toLowerCase() !== "n") {
            cloudUrl = cuData.cloudUrl;
          }
        }
      }
    } catch { /* ignore — we'll use what we have */ }

    console.log();
    console.log("  Configuring OpenClaw...");

    // ---- Step 3: Write config via openclaw CLI ----
    const steps = [
      { label: "Setting cloud URL", args: ["config", "set", "channels.botschat.cloudUrl", cloudUrl] },
      { label: "Setting pairing token", args: ["config", "set", "channels.botschat.pairingToken", pairingToken] },
      { label: "Enabling channel", args: ["config", "set", "channels.botschat.enabled", "true"] },
    ];

    for (const step of steps) {
      process.stdout.write(`    ${step.label}...`);
      const ok = runOpenclaw(step.args);
      console.log(ok ? " done" : " FAILED");
      if (!ok) {
        console.error("  Error: Failed to run openclaw CLI. Is openclaw installed and in PATH?");
        process.exit(1);
      }
    }

    // ---- Step 4: Restart gateway ----
    console.log();
    process.stdout.write("  Restarting gateway...");
    const restarted = runOpenclaw(["gateway", "restart"]);
    console.log(restarted ? " done" : " FAILED (you may need to restart manually)");

    // ---- Step 5: Verify connection ----
    if (jwtToken) {
      console.log();
      process.stdout.write("  Verifying connection...");
      const connected = await checkConnection(cloudUrl, jwtToken);
      if (connected) {
        console.log(" connected!");
        console.log();
        console.log("  Setup complete! Open your BotsChat web UI to start chatting.");
      } else {
        console.log(" not yet connected.");
        console.log("  Check your gateway logs: openclaw gateway logs");
      }
    } else {
      console.log();
      console.log("  Configuration saved! Check connection with:");
      console.log("    openclaw gateway logs");
    }

    console.log();
    console.log("  ─────────────────────────────────────────");
    console.log();
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("  Error:", err.message || err);
  process.exit(1);
});
