# Contributing to BotsChat

## Project Structure

```
botsChat/
├── packages/
│   ├── api/           # Cloudflare Worker — Hono routes, D1, R2, Durable Objects
│   ├── web/           # React SPA frontend (Vite + TypeScript)
│   ├── plugin/        # OpenClaw plugin — WebSocket client that bridges OpenClaw ↔ Cloud
│   └── e2e-crypto/    # E2E encryption library (PBKDF2 + AES-256-CTR)
├── migrations/        # D1 database migration files (NNNN_description.sql)
├── scripts/           # Dev scripts (dev.sh, mock-openclaw.mjs)
├── tests/             # E2E test scripts
├── ios/               # Capacitor iOS shell
├── android/           # Capacitor Android shell
└── wrangler.toml      # Cloudflare Workers configuration
```

## Local Development Setup

### Prerequisites

- Node.js 22+
- npm (ships with Node.js)
- [Gitleaks](https://github.com/gitleaks/gitleaks) — pre-commit secret scanning (`brew install gitleaks`)

### Quick Start

```bash
git clone https://github.com/botschat-app/botsChat.git
cd botsChat
npm install

# Enable pre-commit secret scanning (requires: brew install gitleaks)
git config core.hooksPath .githooks

# One command: build → migrate → start server + mock AI + open browser
./scripts/dev.sh
```

That's it — `dev.sh` auto-generates a dev auth secret, starts the server, launches a Mock OpenClaw in the background, and opens your browser with auto-login. No environment variables to set.

### dev.sh Commands

| Command | What it does |
|---------|-------------|
| `./scripts/dev.sh` | Full dev env: build + migrate + server + mock AI + open browser |
| `./scripts/dev.sh reset` | Wipe local DB + re-migrate + start full dev env |
| `./scripts/dev.sh server` | Server only (no mock, no browser) |
| `./scripts/dev.sh mock` | Start Mock OpenClaw standalone (foreground) |
| `./scripts/dev.sh migrate` | Only run D1 migrations |
| `./scripts/dev.sh build` | Only build web frontend |

### Manual Start

```bash
npm run build -w packages/web
npx wrangler d1 migrations apply botschat-db --local
npx wrangler dev --config wrangler.toml --ip 0.0.0.0 \
  --var ENVIRONMENT:development \
  --var DEV_AUTH_SECRET:any-secret-string
```

### Authentication in Development

Production only allows Google/GitHub OAuth. Local development (`ENVIRONMENT=development`) additionally enables:

- **Email registration**: `POST /api/auth/register` with `{email, password, displayName}`
- **Dev-token login**: `POST /api/dev-auth/login` with `{secret, userId}` — returns a JWT without OAuth. Requires `DEV_AUTH_SECRET` to be set.
- **Auto-login**: `dev.sh` opens the browser with `?dev_token=...` which auto-logs in and sets up E2E encryption automatically.

For manual browser auto-login:

```
http://localhost:8787/?dev_token=<DEV_AUTH_SECRET>&dev_user=<userId>
```

## Testing with Mock OpenClaw

For most development work, you don't need a real OpenClaw instance. The mock script simulates the OpenClaw plugin's WebSocket protocol.

`./scripts/dev.sh` starts Mock OpenClaw automatically in the background (log: `.wrangler/mock-openclaw.log`).

To run the mock standalone (foreground, with full log output):

```bash
# Terminal 1: start server only
./scripts/dev.sh server

# Terminal 2: start mock OpenClaw
./scripts/dev.sh mock
```

Or with a manual pairing token:

```bash
node scripts/mock-openclaw.mjs --token <your_pairing_token>
```

### Mock Options

| Flag | Default | Description |
|------|---------|-------------|
| `--token <pat>` | (required) | Pairing token |
| `--url <url>` | `http://localhost:8787` | Server URL |
| `--agents <list>` | `main` | Comma-separated agent IDs |
| `--delay <ms>` | `300` | Reply delay to simulate thinking |
| `--stream` | `false` | Enable streaming replies (chunk by chunk) |
| `--model <name>` | `mock/echo-1.0` | Reported model name |

### What the Mock Does

| Incoming message | Mock response |
|-----------------|---------------|
| `user.message` | Echoes back as `agent.text`: "Mock reply: {text}" |
| `user.media` | Acknowledges media receipt |
| `user.command` | Acknowledges command |
| `task.scan.request` | Returns empty task list |
| `models.request` | Returns 4 mock models |
| `task.schedule` | Acknowledges with `task.schedule.ack` |
| `task.run` | Simulates 2-second job execution |
| `settings.defaultModel` | Confirms with `defaultModel.updated` |

## Architecture Principles

### Data Ownership

| Owner | Storage | Examples |
|-------|---------|----------|
| **BotsChat** | D1 database | Task names, channel IDs, user info, message records |
| **OpenClaw** | OpenClaw CronService | Schedule, instructions, model, job status |

Key rules:
- **Never cache OpenClaw-owned data in D1 or DO Storage.** Always fetch in real time via WebSocket (`task.scan.request` → `task.scan.result`).
- D1 only stores BotsChat's own metadata (task↔channel associations, user info).

### Interacting with OpenClaw

All CronService mutations must go through the OpenClaw CLI (`openclaw cron add/edit/rm`), never by directly editing `~/.openclaw/cron/jobs.json`.

### ID Generation

- BotsChat entity IDs: prefixed (`tsk_xxx`, `ch_xxx`, `u_xxx`), generated by BotsChat.
- OpenClaw cron job IDs: UUIDs generated by OpenClaw, returned via `task.schedule.ack`.

### ConnectionDO

The Durable Object (`ConnectionDO`) is a WebSocket relay hub — one instance per user. It:
- Holds the persistent WebSocket from the OpenClaw plugin (tagged `"openclaw"`)
- Holds WebSocket(s) from browser sessions (tagged `"browser:<sessionId>"`)
- Relays messages bidirectionally
- Persists messages to D1
- Uses the Hibernation API for zero-cost idle connections

### WebSocket Protocol

JSON messages over WebSocket between the plugin and cloud:

**Cloud → Plugin:**
`user.message`, `user.media`, `user.action`, `user.command`, `task.schedule`, `task.delete`, `task.run`, `task.scan.request`, `models.request`, `settings.defaultModel`, `ping`

**Plugin → Cloud:**
`auth`, `agent.text`, `agent.media`, `agent.a2ui`, `agent.stream.start/chunk/end`, `status`, `pong`, `task.scan.result`, `task.schedule.ack`, `job.update`, `job.output`, `models.list`, `model.changed`, `defaultModel.updated`

See `packages/plugin/src/types.ts` for full type definitions.

## Database Migrations

Migration files live in `migrations/`, named `NNNN_description.sql`.

```bash
# Apply locally
npx wrangler d1 migrations apply botschat-db --local

# Apply to production
npx wrangler d1 migrations apply botschat-db --remote

# Full local reset
rm -rf .wrangler/state
npx wrangler d1 migrations apply botschat-db --local
```

## Running Tests

```bash
# API tests (17 cases — upload, auth, channels, media)
./tests/media-api-test.sh

# WebSocket tests (9 cases — connect, messaging, media)
node tests/media-ws-test.mjs

# E2E crypto unit tests
npm test -w packages/e2e-crypto
```

## Building

```bash
npm run build -w packages/web       # Build frontend
npm run build -w packages/plugin    # Build plugin
npm run build -w packages/e2e-crypto # Build crypto lib
```

## Deploying to Cloudflare

```bash
npm run build -w packages/web
npx wrangler deploy --config wrangler.toml
npx wrangler d1 migrations apply botschat-db --remote
```

Production uses `ENVIRONMENT=production` (OAuth only). Secrets are set via `wrangler secret put`.

## UI Design

The frontend follows a Slack-inspired design system with dark/light dual themes. Key principles:

- **Three-column layout**: Icon Rail + Sidebar + Main Content + optional Detail Panel
- **Flat message rows** (not bubbles) for information density
- **Sidebar always dark/brand-colored**, only Main Content follows theme
- **CSS variable tokens** for all colors, spacing, and radii

For the full design specification (color system, typography, components, spacing), see `.cursor/rules/design-guideline.md`.

## Secret Scanning

We use [Gitleaks](https://github.com/gitleaks/gitleaks) to prevent accidental secret commits. A pre-commit hook runs automatically after setup.

### Setup (one-time)

```bash
# Install gitleaks
brew install gitleaks    # macOS
# or: https://github.com/gitleaks/gitleaks#installing

# The pre-commit hook is installed via the git hooks directory
# (already configured in this repo — just make sure gitleaks is on your PATH)
```

### How It Works

| Layer | Tool | When |
|-------|------|------|
| Local | Gitleaks pre-commit hook | Every `git commit` — blocks commits containing secrets |
| CI | Gitleaks GitHub Action | Every push / PR — catches anything that slipped through |
| GitHub | Secret Scanning + Push Protection | Server-side — blocks pushes with known secret patterns |

### What's Allowed

Firebase client-side keys (`VITE_FIREBASE_*`), VAPID keys, and Google OAuth client IDs are **designed to be public** (embedded in browser bundles). These are allowlisted in `.gitleaks.toml`.

### What's NOT Allowed

- Service account JSON files (`*-firebase-adminsdk-*.json`)
- Private keys (`.p8`, `.pem`, `.key`)
- `JWT_SECRET`, `DEV_AUTH_SECRET`, `FCM_SERVICE_ACCOUNT_JSON` values
- Android keystores (`.jks`) and `keystore.properties`
- Any API secret / token with server-side privileges

### Manual Scan

```bash
# Scan the entire repo history (auto-reads .gitleaks.toml)
gitleaks git --redact --verbose

# Scan only staged changes (same as the pre-commit hook)
gitleaks git --pre-commit --staged --redact --verbose

# Scan working directory (dir mode needs explicit -c)
gitleaks dir -c .gitleaks.toml --redact --verbose .
```

## Debugging Tips

- **Port conflict**: `lsof -ti:8787 | xargs kill -9`
- **D1 schema error** ("no such column"): Reset local DB with `./scripts/dev.sh reset`
- **Plugin WS URL**: `cloudUrl` must be `http://...` (not `https://`); the plugin auto-converts to `ws://`
- **Blank screen after login**: Hard refresh (`Cmd+Shift+R`) or clear localStorage
