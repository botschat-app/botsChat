# BotsChat

A self-hosted chat interface for [OpenClaw](https://github.com/openclaw/openclaw) AI agents.

BotsChat gives you a modern, Slack-like web UI to interact with your OpenClaw agents — organize conversations into **Channels**, schedule **Background Tasks**, and monitor **Job** executions. Everything runs on your own infrastructure; your API keys and data never leave your machine.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Your Machine                                                         │
│                                                                       │
│  ┌───────────────────────┐     outbound WSS      ┌────────────────┐   │
│  │ OpenClaw Gateway      │ ────────────────────>  │ BotsChat       │   │
│  │  + BotsChat Plugin    │                        │ (Wrangler)     │   │
│  │  + Your AI Agents     │  <── agent responses   │                │   │
│  │  + Your API Keys      │  ──> user messages     │  ┌──────────┐  │   │
│  └───────────────────────┘                        │  │ Web UI   │  │   │
│                                                   │  │ (React)  │  │   │
│         AI processing happens here.               │  └──────────┘  │   │
│         Nothing leaves your machine.              └────────────────┘   │
│                                                     localhost:8787     │
└─────────────────────────────────────────────────────────────────────────┘
```

OpenClaw runs your agents locally (with your API keys, data, and configs). It connects via **outbound WebSocket** to the BotsChat server — which can also run on the same machine. No cloud account required, no port forwarding, no tunnels.

> **Optional:** You can also deploy BotsChat to Cloudflare Workers for remote access. See [Deploy to Cloudflare](#deploy-to-cloudflare) below.

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

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/botschat-app/botsChat.git
cd botsChat
npm install
```

### 2. Start the server

```bash
# One-command startup: build web → migrate D1 → start server
./scripts/dev.sh

# Or step by step:
npm run build -w packages/web       # Build the React frontend
npm run db:migrate                   # Apply D1 migrations (local)
npx wrangler dev --config wrangler.toml --ip 0.0.0.0   # Start on port 8787
```

Open `http://localhost:8787` in your browser. Register an account and generate a **pairing token** from the dashboard.

> Wrangler uses [Miniflare](https://miniflare.dev) under the hood, so D1, R2, and Durable Objects all run locally — **no Cloudflare account needed**.

### 3. Connect OpenClaw

On the machine running OpenClaw:

```bash
# Install the BotsChat plugin
openclaw plugins install @botschat/openclaw-plugin

# Point it to your BotsChat server
openclaw channel setup botschat \
  --url http://localhost:8787 \
  --token bc_pat_xxxxxxxxxxxxxxxx
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

### 4. Verify

```bash
openclaw channels status
```

You should see:

```
Channel    Account    Status
─────────  ─────────  ──────────────────
BotsChat   default    connected ✓
```

Open `http://localhost:8787` in your browser, sign in, and start chatting with your agents.

### How It Works

1. When your OpenClaw gateway starts, the BotsChat plugin establishes an **outbound WebSocket** to `ws://<your-botschat-host>/api/gateway/<your-user-id>`.
2. This WebSocket stays connected (with automatic reconnection if it drops).
3. When you type a message in the web UI, it travels: **Browser → ConnectionDO → WebSocket → OpenClaw → Agent → response back through the same path**.
4. Your API keys, agent configs, and data never leave your machine — only chat messages travel through the relay.

### Managing Channels

Each Channel maps to an OpenClaw Agent. When you create a Channel in the web UI, it tells OpenClaw to configure a new agent:

```json
{
  "agents": {
    "list": [
      { "id": "research", "name": "Research Bot" },
      { "id": "social-media", "name": "Social Media Manager" }
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
  "agentId": "social-media",
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

| Key             | Type    | Required | Description                                          |
|-----------------|---------|----------|------------------------------------------------------|
| `enabled`       | boolean | no       | Enable/disable the channel (default: true)           |
| `cloudUrl`      | string  | yes      | BotsChat server URL (e.g. `http://localhost:8787`)   |
| `pairingToken`  | string  | yes      | Your pairing token from the BotsChat dashboard       |
| `name`          | string  | no       | Display name for this connection                     |

### Uninstall

```bash
openclaw plugins disable botschat
# or remove entirely:
openclaw plugins remove botschat
```

---

## Deploy to Cloudflare

For remote access (e.g. chatting with your agents from your phone), you can deploy BotsChat to Cloudflare Workers. The free tier is more than enough for personal use.

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/) (free plan works)

### Create Resources

```bash
# Create D1 database
wrangler d1 create botschat-db
# Copy the database_id from the output into wrangler.toml

# Create R2 bucket
wrangler r2 bucket create botschat-media
```

Update `wrangler.toml` with the actual `database_id`.

### Deploy

```bash
# Build web frontend
npm run build -w packages/web

# Deploy everything (API + web + Durable Objects)
npm run deploy

# Apply migrations to remote D1
npm run db:migrate:remote

# Set a production JWT secret
wrangler secret put JWT_SECRET
```

### Cloudflare Services Used

| Service          | Purpose                                | Free Tier                        |
|------------------|----------------------------------------|----------------------------------|
| Workers          | API server (Hono)                      | 100K req/day                     |
| Durable Objects  | WebSocket relay (ConnectionDO)         | 1M req/mo, hibernation = free    |
| D1               | Database (users, channels, tasks)      | 5M reads/day, 100K writes/day   |
| R2               | Media storage                          | 10GB, no egress fees             |

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

### Project Structure

```
botsChat/
├── packages/
│   ├── plugin/        # @botschat/openclaw-plugin (OpenClaw channel plugin)
│   ├── api/           # Cloudflare Workers API (Hono + Durable Objects)
│   └── web/           # React SPA (Vite + Tailwind)
├── migrations/        # D1 database schema
├── scripts/           # Dev helper scripts
├── wrangler.toml      # Wrangler configuration
└── package.json       # Monorepo root (npm workspaces)
```

### Source Layout

```
packages/plugin/         OpenClaw channel plugin
  index.ts               Plugin entry point (register)
  src/channel.ts         ChannelPlugin implementation (all adapters)
  src/ws-client.ts       Outbound WSS client with reconnection
  src/accounts.ts        Account config helpers
  src/types.ts           Config + protocol types

packages/api/            API server
  src/index.ts           Hono app + route wiring + WS proxy
  src/do/connection-do.ts   Durable Object (WebSocket relay)
  src/routes/auth.ts     Register / login
  src/routes/channels.ts Channel CRUD
  src/routes/tasks.ts    Task CRUD (background + adhoc)
  src/routes/pairing.ts  Pairing token management

packages/web/            React frontend
  src/App.tsx            Main app (state, WS lifecycle)
  src/components/
    Sidebar.tsx          Channel list
    TaskBar.tsx          Task pill switcher
    ChatWindow.tsx       Chat messages + input
    ThreadPanel.tsx      Slide-out thread panel
    JobList.tsx          Background task execution history
    LoginPage.tsx        Auth form
```

## License

MIT
