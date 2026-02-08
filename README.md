# BotsChat

[![npm](https://img.shields.io/npm/v/botschat)](https://www.npmjs.com/package/botschat)
[![npm](https://img.shields.io/npm/v/@botschat/openclaw-plugin)](https://www.npmjs.com/package/@botschat/openclaw-plugin)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A self-hosted chat interface for [OpenClaw](https://github.com/openclaw/openclaw) AI agents.

BotsChat gives you a modern, Slack-like web UI to interact with your OpenClaw agents — organize conversations into **Channels**, schedule **Background Tasks**, and monitor **Job** executions. Everything runs on your own infrastructure; your API keys and data never leave your machine.

## Architecture

![BotsChat Architecture](docs/architecture.png)

OpenClaw runs your agents locally (with your API keys, data, and configs). The BotsChat plugin establishes an **outbound WebSocket** to the BotsChat server — no port forwarding, no tunnels. Your API keys and data never leave your machine; only chat messages travel through the relay.

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

- [Node.js](https://nodejs.org/) 22+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- An [OpenClaw](https://github.com/openclaw/openclaw) instance

### Step 1: Clone and Install

```bash
git clone https://github.com/botschat-app/botsChat.git
cd botsChat
npm install
```

### Step 2: Deploy BotsChat Server

Choose one of the two options below:

#### Option A: Run Locally

Wrangler uses [Miniflare](https://miniflare.dev) under the hood, so D1, R2, and Durable Objects all run locally — **no Cloudflare account needed**.

```bash
# One-command startup: build web → migrate D1 → start server on 0.0.0.0:8787
./scripts/dev.sh
```

Or step by step:

```bash
npm run build -w packages/web                          # Build the React frontend
npm run db:migrate                                     # Apply D1 migrations (local)
npx wrangler dev --config wrangler.toml --ip 0.0.0.0   # Start on port 8787
```

Open `http://localhost:8787` in your browser.

Other dev commands:

```bash
./scripts/dev.sh reset     # Nuke local DB → re-migrate → start
./scripts/dev.sh migrate   # Only run D1 migrations
./scripts/dev.sh build     # Only build web frontend
./scripts/dev.sh sync      # Sync plugin to remote OpenClaw host + restart gateway
./scripts/dev.sh logs      # Tail remote gateway logs
```

#### Option B: Deploy to Cloudflare

For remote access (e.g. chatting with your agents from your phone), deploy to Cloudflare Workers. The free tier is more than enough for personal use.

```bash
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

### Step 3: Install the OpenClaw Plugin

After the BotsChat server is running, connect your OpenClaw instance to it.

**1. Install the plugin**

```bash
openclaw plugins install @botschat/openclaw-plugin
```

**2. Create a pairing token**

Open the BotsChat web UI, register an account, and generate a **pairing token** from the dashboard.

**3. Configure the connection**

```bash
# For local deployment, use http://localhost:8787 or your LAN IP
# For Cloudflare deployment, use your Workers URL
openclaw config set channels.botschat.cloudUrl <BOTSCHAT_URL>
openclaw config set channels.botschat.pairingToken <YOUR_PAIRING_TOKEN>
openclaw config set channels.botschat.enabled true
```

This writes the following to your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "botschat": {
      "enabled": true,
      "cloudUrl": "http://localhost:8787",
      "pairingToken": "bc_pat_xxxxxxxxxxxxxxxx"
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

## Plugin Reference

### Configuration

All config lives under `channels.botschat` in your `openclaw.json`:

| Key             | Type    | Required | Description                                          |
|-----------------|---------|----------|------------------------------------------------------|
| `enabled`       | boolean | no       | Enable/disable the channel (default: true)           |
| `cloudUrl`      | string  | yes      | BotsChat server URL (e.g. `http://localhost:8787`)   |
| `pairingToken`  | string  | yes      | Your pairing token from the BotsChat dashboard       |
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

### Build the plugin

```bash
npm run build:plugin
```

### Type-check everything

```bash
npm run typecheck
```


## License

Apache-2.0
