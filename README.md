# BotsChat

Cloud-based multi-project AI chat platform, powered by [OpenClaw](https://github.com/openclaw/openclaw).

BotsChat lets you organize AI agent workflows into **Projects**, **Tasks**, and **Jobs** — with a modern web chat UI that connects to your self-hosted OpenClaw instance. Think of it as a Slack-like interface for your AI agents.

## How it works

```
┌─────────────────────────────┐        outbound WSS        ┌─────────────────────────┐
│  Your Machine / Server      │ ──────────────────────────> │  BotsChat Cloud         │
│                             │                             │  (Cloudflare Edge)      │
│  ┌───────────────────────┐  │                             │                         │
│  │ OpenClaw Gateway      │  │  <── agent responses ───    │  ┌───────────────────┐  │
│  │  + BotsChat Plugin    │  │  ──> user messages    ───>  │  │ ConnectionDO      │  │
│  │  + Your AI Agents     │  │                             │  │ (per-user relay)  │  │
│  └───────────────────────┘  │                             │  └────────┬──────────┘  │
│                             │                             │           │              │
└─────────────────────────────┘                             │  ┌────────▼──────────┐  │
                                                            │  │ React SPA         │  │
         No port forwarding needed!                         │  │ (chat UI)         │  │
         OpenClaw connects outbound.                        │  └───────────────────┘  │
                                                            └─────────────────────────┘
```

OpenClaw runs on your own machine (with your API keys, data, and agent configs). It connects **outbound** to the BotsChat cloud — the same pattern Discord bots use. No port forwarding, no tunnels.

## Core Concepts

| BotsChat      | What it is                                         | OpenClaw mapping       |
|---------------|----------------------------------------------------|------------------------|
| **Project**   | A high-level goal (e.g. "Bolt X Promotion")        | Agent (`agentId`)      |
| **Task**      | A type of work under a Project                     | CronJob or Session     |
| **Job**       | One execution of a Background Task                 | CronRunLogEntry        |
| **Thread**    | A branched sub-conversation from any message       | Thread Session         |

**Task types:**

- **Background Task** — runs on a cron schedule (e.g. "post a tweet every 6 hours"). Each run creates a Job with its own conversation session.
- **Ad Hoc Chat** — a regular conversation you start whenever you want.

## Project Structure

```
botsChat/
├── packages/
│   ├── plugin/        # @botschat/openclaw-plugin (npm package)
│   ├── api/           # Cloudflare Workers API (Hono + Durable Objects)
│   └── web/           # React SPA (Cloudflare Pages)
├── migrations/        # D1 database schema
├── wrangler.toml      # Cloudflare configuration
└── package.json       # Monorepo root
```

---

## For OpenClaw Users

### Quick Start

**1. Register on BotsChat**

Go to your BotsChat instance (or the hosted version) and create an account. From the dashboard, generate a **pairing token**.

**2. Install the plugin**

```bash
openclaw plugins install @botschat/openclaw-plugin
```

**3. Connect to BotsChat**

```bash
openclaw channel setup botschat --url botschat.app --token bc_pat_xxxxxxxxxxxxxxxx
```

This writes the following to your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "botschat": {
      "enabled": true,
      "cloudUrl": "botschat.app",
      "pairingToken": "bc_pat_xxxxxxxxxxxxxxxx"
    }
  }
}
```

**4. Verify the connection**

```bash
openclaw channels status
```

You should see:

```
Channel    Account    Status
─────────  ─────────  ──────────────────
BotsChat   default    connected ✓
```

**5. Open the web UI**

Go to `https://botschat.app` in your browser, sign in, and start chatting with your agents.

### What Happens Under the Hood

1. When your OpenClaw gateway starts, the BotsChat plugin establishes an **outbound WebSocket** to `wss://botschat.app/api/gateway/<your-user-id>`.
2. This WebSocket stays connected (with automatic reconnection if it drops).
3. When you type a message in the BotsChat web UI, it travels: **Browser → ConnectionDO → OpenClaw → Agent processes → response back through the same path**.
4. Your API keys, agent configs, and data never leave your machine — only chat messages travel through the cloud relay.

### Managing Multiple Projects

Each BotsChat Project maps to an OpenClaw Agent. When you create a Project in the web UI, it tells OpenClaw to configure a new agent:

```json
{
  "agents": {
    "list": [
      { "id": "bolt-x-promo", "name": "Bolt X Promotion" },
      { "id": "research", "name": "Research Bot" }
    ]
  }
}
```

Each agent has its own isolated workspace, system prompt, tools, and sessions.

### Background Tasks (Cron Jobs)

Background Tasks map to OpenClaw CronJobs. When you create one in the web UI (e.g. "Post tweet every 6 hours"), BotsChat writes a cron config to OpenClaw:

```json
{
  "id": "cron_abc123",
  "agentId": "bolt-x-promo",
  "name": "Scheduled Tweets",
  "schedule": { "type": "every", "intervalMs": 21600000 },
  "enabled": true,
  "sessionTarget": "isolated",
  "payload": { "kind": "agentTurn", "prompt": "Post a tweet about..." }
}
```

Each execution (Job) creates its own session. You can click on any Job in the web UI to see what the agent did and continue the conversation.

### Plugin Configuration Reference

All config lives under `channels.botschat` in your `openclaw.json`:

| Key             | Type    | Required | Description                                |
|-----------------|---------|----------|--------------------------------------------|
| `enabled`       | boolean | no       | Enable/disable the channel (default: true) |
| `cloudUrl`      | string  | yes      | BotsChat cloud hostname (e.g. `botschat.app`) |
| `pairingToken`  | string  | yes      | Your pairing token from the BotsChat dashboard |
| `name`          | string  | no       | Display name for this connection           |

### Uninstall

```bash
openclaw plugins disable botschat
# or remove entirely:
openclaw plugins remove botschat
```

---

## Self-Hosting BotsChat Cloud

You can deploy your own BotsChat instance on Cloudflare.

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Cloudflare account](https://dash.cloudflare.com/) (free plan works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### Setup

```bash
git clone https://github.com/botschat-app/botsChat.git
cd botsChat
npm install
```

### Create Cloudflare Resources

```bash
# Create D1 database
wrangler d1 create botschat-db
# Copy the database_id from the output into wrangler.toml

# Create R2 bucket
wrangler r2 bucket create botschat-media
```

Update `wrangler.toml` with the actual `database_id` from the `d1 create` output.

### Run Locally

```bash
# Apply database migrations
npm run db:migrate

# Start the API server (port 8787)
npm run dev:api

# In another terminal, start the web UI (port 3000)
npm run dev:web
```

Open `http://localhost:3000` to use the app. The Vite dev server proxies `/api` requests to the Workers dev server on port 8787.

### Deploy to Production

```bash
# Deploy API + Durable Objects
npm run deploy

# Deploy web UI to Pages
npm run deploy:web

# Apply migrations to remote D1
npm run db:migrate:remote
```

### Environment Variables

Set a production JWT secret:

```bash
wrangler secret put JWT_SECRET
```

### Cloudflare Services Used

| Service          | Purpose                              | Free Tier                        |
|------------------|--------------------------------------|----------------------------------|
| Workers          | API server (Hono)                    | 100K req/day                     |
| Durable Objects  | WebSocket relay (ConnectionDO)       | 1M req/mo, hibernation = free    |
| D1               | Database (users, projects, tasks)    | 5M reads/day, 100K writes/day    |
| R2               | Media storage                        | 10GB, no egress fees             |
| Pages            | Static frontend hosting              | Unlimited                        |

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

### Project layout

```
packages/plugin/         OpenClaw channel plugin
  index.ts               Plugin entry point (register)
  src/channel.ts         ChannelPlugin implementation (all adapters)
  src/ws-client.ts       Outbound WSS client with reconnection
  src/accounts.ts        Account config helpers
  src/types.ts           Config + protocol types

packages/api/            Cloudflare Workers API
  src/index.ts           Hono app + route wiring + WS proxy
  src/do/connection-do.ts   Durable Object (WebSocket relay)
  src/routes/auth.ts     Register / login
  src/routes/projects.ts Project CRUD
  src/routes/tasks.ts    Task CRUD (background + adhoc)
  src/routes/pairing.ts  Pairing token management

packages/web/            React frontend
  src/App.tsx            Main app (state, WS lifecycle)
  src/components/
    Sidebar.tsx          Project list
    TaskBar.tsx          Task pill switcher
    ChatWindow.tsx       Chat messages + input + skill bar
    ThreadPanel.tsx      Slide-out thread panel
    JobList.tsx          Background task execution history
    LoginPage.tsx        Auth form
```

## License

MIT
