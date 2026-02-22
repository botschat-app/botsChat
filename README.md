# BotsChat

[![npm](https://img.shields.io/npm/v/botschat)](https://www.npmjs.com/package/botschat)
[![npm](https://img.shields.io/npm/v/@botschat/botschat)](https://www.npmjs.com/package/@botschat/botschat)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A self-hosted, **end-to-end encrypted** chat interface for [OpenClaw](https://github.com/openclaw/openclaw) AI agents.

BotsChat gives you a modern, Slack-like web UI to interact with your OpenClaw agents — organize conversations into **Channels**, schedule **Background Tasks**, and monitor **Job** executions. With **E2E encryption**, your chat messages, cron prompts, and job summaries are encrypted on your device before they ever leave — the server only sees ciphertext it cannot decrypt. Your API keys and data never leave your machine.

<div align="center">

<video src="https://raw.githubusercontent.com/botschat-app/botsChat/main/docs/botschat-intro.mp4" controls muted width="100%">
  <a href="https://www.youtube.com/watch?v=_ifqYhoV7Jk">▶ Watch the BotsChat Introduction Video</a>
</video>

</div>

## Key Features

### Structured Conversation Management

BotsChat organizes your conversations through a **Channel → Session → Thread** three-layer hierarchy, keeping complex agent interactions clean and navigable:

- **Channel** — one workspace per agent (e.g. "#General", "#BotsChat"), listed in the left sidebar.
- **Session** — multiple session tabs within each channel, so you can run parallel conversations without losing context.
- **Thread** — branch off from any message to start a focused sub-conversation in the right panel, without cluttering the main chat.

You can also **switch models on the fly** from the top-right selector, and trigger common **Skills** (like `/model`, `/help`, `/skills`) directly from the command bar at the bottom of the chat.

![Conversation Structure — Channel, Session, and Thread](docs/thread.png)

### Interactive Agent UI (A2UI)

Instead of plain text walls, BotsChat renders agent responses as **interactive UI elements** — clickable buttons, radio groups, and selection cards. When an agent asks "What kind of project do you want to create?", you see styled option buttons you can click, not just text to read and retype. This makes multi-step workflows feel like a guided wizard rather than a raw chat.

![Interactive UI — Agent responses rendered as buttons and selection cards](docs/a2ui.png)

### Background Task Automation

Schedule **cron-style background tasks** that run your agents on autopilot. Each task has its own prompt, schedule, model selection, and full execution history. You can view detailed job logs, re-run tasks on demand, and enable/disable them with a single toggle.

![Background Task — Schedule, prompt, and execution history](docs/cron.png)

### End-to-End Encryption

BotsChat supports **optional E2E encryption** so the server never sees your content in plaintext:

- **What's encrypted**: Chat messages, cron task prompts, and job execution summaries — all encrypted with AES-256-CTR before leaving your browser or plugin.
- **Zero-knowledge server**: The BotsChat cloud/server stores only ciphertext and cannot decrypt your data. No keys, no salts stored server-side.
- **How it works**: You set an E2E password in both the web UI and the OpenClaw plugin. Both sides derive the same encryption key using `PBKDF2(password, userId)`. Messages are encrypted/decrypted locally — the server just relays and stores opaque bytes.
- **Zero overhead**: AES-CTR produces ciphertext the same size as plaintext — no bloat, no padding.

### Built-in Debug Log

A collapsible **Debug Log** panel at the bottom of the UI gives you real-time visibility into what's happening under the hood — WebSocket events, cron task loading, agent scan results, and more. Filter by log level (ALL, WS, WST, API, INF, WRN, ERR) to quickly diagnose issues without leaving the chat interface.

![Debug Log — Real-time logs with level filtering](docs/debug.png)

---

## Architecture

![BotsChat Architecture](docs/architecture.png)

OpenClaw runs your agents locally (with your API keys, data, and configs). The BotsChat plugin establishes an **outbound WebSocket** to the BotsChat server — no port forwarding, no tunnels. Your API keys and data never leave your machine.

When **E2E encryption** is enabled, messages are encrypted on the sender's device (browser or plugin) before transmission. The BotsChat server (ConnectionDO) only relays and stores opaque ciphertext — it has no access to keys and cannot read your content. Encryption keys are derived locally from your password and never sent over the network.

You can run BotsChat locally on the same machine, or deploy it to Cloudflare for remote access (e.g. from your phone).

## Concepts

BotsChat introduces a few UI-level concepts that map to OpenClaw primitives:

| BotsChat          | What it is                                              | OpenClaw mapping         |
|-------------------|---------------------------------------------------------|--------------------------|
| **Channel**       | A workspace for one agent (e.g. "Research Bot")         | Agent (`agentId`)        |
| **Task**          | A unit of work under a Channel                          | CronJob or Session       |
| **Job**           | One execution of a Background Task                      | CronRunLogEntry          |
| **Session**       | A conversation thread within a Task                     | Session                  |
| **Thread**        | A branched sub-conversation from any message            | Thread Session           |

**Task types:**

- **Background Task** — runs on a cron schedule (e.g. "post a tweet every 6 hours"). Each run creates a Job with its own conversation session.
- **Ad Hoc Chat** — a regular conversation you start whenever you want.

## Getting Started

### Prerequisites

- An [OpenClaw](https://github.com/openclaw/openclaw) instance
- For self-hosting (Option B or C): [Node.js](https://nodejs.org/) 22+, [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### Choose Your Deployment

BotsChat is **100% open source** — the [same code](https://github.com/botschat-app/botsChat) runs whether you use our hosted console, run it locally, or deploy to your own Cloudflare. The only difference is *where* the server runs; your API keys and data always stay on your machine.

| Mode | Best for | Clone repo? |
|------|----------|-------------|
| **A. Hosted Console** | Zero setup, start in minutes | No |
| **B. Run Locally** | Development, no cloud account | Yes |
| **C. Deploy to Cloudflare** | Remote access (e.g. from phone) | Yes |

Pick one below and follow its steps, then continue to [Install the OpenClaw Plugin](#install-the-openclaw-plugin).

---

#### Option A: Hosted Console (Recommended)

We run the same open-source stack at **[console.botschat.app](https://console.botschat.app)**. No clone, no deploy: open the link → sign up → create a pairing token → connect OpenClaw.

Your API keys and data still stay on your machine; the hosted console only relays chat messages via WebSocket. Enable **E2E encryption** for complete privacy — the hosted console cannot decrypt your content.

→ Then go to [Install the OpenClaw Plugin](#install-the-openclaw-plugin).

---

#### Option B: Run Locally

Clone, install, and run the server on your machine. Wrangler uses [Miniflare](https://miniflare.dev), so D1, R2, and Durable Objects all run locally — **no Cloudflare account needed**.

```bash
git clone https://github.com/botschat-app/botsChat.git
cd botsChat
npm install
./scripts/dev.sh
```

One command does everything: build frontend → migrate database → start server → launch Mock AI → open browser with auto-login. No environment variables to set, no separate terminals to manage.

Other dev commands:

```bash
./scripts/dev.sh reset     # Nuke local DB → re-migrate → start full dev env
./scripts/dev.sh server    # Server only (no mock AI, no browser)
./scripts/dev.sh mock      # Start mock OpenClaw standalone (foreground)
./scripts/dev.sh migrate   # Only run D1 migrations
./scripts/dev.sh build     # Only build web frontend
./scripts/dev.sh sync      # Sync plugin to remote OpenClaw host + restart gateway
./scripts/dev.sh logs      # Tail remote gateway logs
```

→ Then go to [Install the OpenClaw Plugin](#install-the-openclaw-plugin).

---

#### Option C: Deploy to Cloudflare

For remote access (e.g. chatting from your phone), deploy the same code to Cloudflare Workers. The free tier is enough for personal use.

```bash
git clone https://github.com/botschat-app/botsChat.git
cd botsChat
npm install

# Create Cloudflare resources
wrangler d1 create botschat-db          # Copy the database_id into wrangler.toml
wrangler r2 bucket create botschat-media

# Build & deploy
npm run build -w packages/web           # Build the React frontend
npm run deploy                          # Deploy API + web + Durable Objects
npm run db:migrate:remote               # Apply migrations to remote D1
wrangler secret put JWT_SECRET          # Set a production JWT secret
```

| Service          | Purpose                                | Free Tier                        |
|------------------|----------------------------------------|----------------------------------|
| Workers          | API server (Hono)                      | 100K req/day                     |
| Durable Objects  | WebSocket relay (ConnectionDO)         | 1M req/mo, hibernation = free    |
| D1               | Database (users, channels, tasks)      | 5M reads/day, 100K writes/day   |
| R2               | Media storage                          | 10GB, no egress fees             |

→ Then go to [Install the OpenClaw Plugin](#install-the-openclaw-plugin).

---

### Install the OpenClaw Plugin

After the BotsChat server is running, connect your OpenClaw instance to it.

**1. Install the plugin**

```bash
openclaw plugins install @botschat/botschat
```

**2. Create a pairing token**

Open the BotsChat web UI, register an account, and generate a **pairing token** from the dashboard.

**3. Configure the connection**

```bash
# For hosted console, use https://console.botschat.app
# For local deployment, use http://localhost:8787 or your LAN IP
# For Cloudflare deployment, use your Workers URL
openclaw config set channels.botschat.cloudUrl <BOTSCHAT_URL>
openclaw config set channels.botschat.pairingToken <YOUR_PAIRING_TOKEN>
openclaw config set channels.botschat.enabled true
```

**3b. (Optional) Enable E2E encryption**

Set the same password you'll use in the BotsChat web UI:

```bash
openclaw config set channels.botschat.e2ePassword "your-secret-e2e-password"
```

This writes the following to your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "botschat": {
      "enabled": true,
      "cloudUrl": "http://localhost:8787",
      "pairingToken": "bc_pat_xxxxxxxxxxxxxxxx",
      "e2ePassword": "your-secret-e2e-password"
    }
  }
}
```

**4. Restart the gateway and verify**

```bash
openclaw gateway restart
```

Check the gateway logs — you should see:

```
Authenticated with BotsChat cloud
Task scan complete
```

Open the BotsChat web UI in your browser, sign in, and start chatting with your agents.

### How It Works

1. When your OpenClaw gateway starts, the BotsChat plugin establishes an **outbound WebSocket** to `ws://<your-botschat-host>/api/gateway/<your-user-id>`.
2. This WebSocket stays connected (with automatic reconnection if it drops).
3. When you type a message in the web UI, it travels: **Browser → ConnectionDO → WebSocket → OpenClaw → Agent → response back through the same path**.
4. Your API keys, agent configs, and data never leave your machine — only chat messages travel through the relay.
5. With **E2E encryption** enabled, messages are encrypted **before** step 3 and decrypted **after** — the ConnectionDO and database only ever see ciphertext.

## Plugin Reference

### Configuration

All config lives under `channels.botschat` in your `openclaw.json`:

| Key             | Type    | Required | Description                                          |
|-----------------|---------|----------|------------------------------------------------------|
| `enabled`       | boolean | no       | Enable/disable the channel (default: true)           |
| `cloudUrl`      | string  | yes      | BotsChat server URL (e.g. `http://localhost:8787`)   |
| `pairingToken`  | string  | yes      | Your pairing token from the BotsChat dashboard       |
| `e2ePassword`   | string  | no       | E2E encryption password (must match the web UI)      |
| `name`          | string  | no       | Display name for this connection                     |

### Message Protocol

The plugin uses a JSON-based WebSocket protocol:

| Direction          | Message Types                                                    |
|--------------------|------------------------------------------------------------------|
| Cloud → Plugin     | `user.message`, `user.action`, `user.command`, `task.schedule`, `task.delete`, `task.run`, `task.scan.request` |
| Plugin → Cloud     | `agent.text`, `agent.media`, `agent.a2ui`, `agent.stream.*`, `job.update`, `job.output`, `task.scan.result`, `model.changed` |

### Uninstall

```bash
openclaw plugins disable botschat
# or remove entirely:
openclaw plugins remove botschat
```

---

## Development

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full development guide — local setup, Mock OpenClaw for testing, architecture principles, WebSocket protocol, database migrations, and more.

### Quick Start

```bash
./scripts/dev.sh         # Build + migrate + start server + mock AI + open browser
```

### Build

```bash
npm run build -w packages/web      # Build frontend
npm run build -w packages/plugin   # Build plugin
```


## Author

Made by [auxten](https://github.com/auxten) — author of [chDB](https://github.com/chdb-io/chdb), contributor to [ClickHouse](https://github.com/ClickHouse/ClickHouse), [Jemalloc](https://github.com/jemalloc/jemalloc), [Kubernetes](https://github.com/kubernetes/kubernetes), [Memcached](https://github.com/memcached/memcached), [CockroachDB](https://github.com/cockroachdb/cockroach), and [Superset](https://github.com/apache/superset).

Assisted by [Daniel Robbins](https://github.com/Daniel-Robbins) — an [OpenClaw](https://github.com/openclaw/openclaw) AI agent running on a headless Mac Mini (kept alive by [MacMate](https://macmate.app)). It writes code, opens PRs, and lives in a closet. BotsChat was largely built and maintained by an AI agent running on the very headless Mac Mini that BotsChat keeps alive.

Website: [botschat.app](https://botschat.app) · Contact: [auxtenwpc@gmail.com](mailto:auxtenwpc@gmail.com)

## License

Apache-2.0

© 2026 [Auxten.com](https://auxten.com)
