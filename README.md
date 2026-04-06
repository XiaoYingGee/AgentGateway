# AgentGateway

A universal AI Agent gateway deployed on Cloudflare's edge network. It bridges local AI agents (Claude Code, etc.) to IM platforms (Discord, etc.) through a secure, encrypted tunnel.

**Current implementation:** CF Worker gateway + Discord + Claude Code CLI

```
Discord (/claude prompt)
    ↓ webhook
CF Worker (auth + rate limit + HMAC signing)
    ↓ Cloudflare Tunnel
Local Agent Service (Node.js)
    ↓ execFile
Claude Code CLI → Discord REST API (reply)
```

## Features

- Remote Claude Code access from Discord with full capabilities (read/write files, run commands, git)
- Five-layer security: Discord Ed25519 → user whitelist → CF Tunnel → HMAC-SHA256 → path isolation
- Thread-based session management with context continuity
- Smart message splitting for Discord's character limit (code block aware)
- Extensible adapter architecture for future agents

## Project Structure

```
AgentGateway/
├── gateway/          # Cloudflare Worker (edge gateway)
├── agent-service/    # Local Node.js service (runs on your machine)
├── scripts/          # Setup & utility scripts
└── docs/             # Design docs & debugging logs
```

## Prerequisites

| Tool | Purpose |
|------|---------|
| Node.js 18+ | Agent service runtime |
| [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) | Tunnel connector |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | AI agent backend |
| Cloudflare account | Worker + Tunnel hosting |
| Discord application | Bot + slash commands |

## Quick Start

### 1. Clone and install

```bash
git clone <repo-url> && cd AgentGateway

# One-click setup: checks prerequisites + installs dependencies + builds
./scripts/setup.sh
```

Or manually:

```bash
cd gateway && npm install && cd ..
cd agent-service && npm install && cd ..
```

### 2. Discord setup

Create a Discord Application at https://discord.com/developers/applications:
- Copy **Application ID** and **Public Key**
- Create a Bot, copy the **Bot Token**
- Enable the bot's **Message Content** intent (optional)

Register the `/claude` slash command:

```bash
DISCORD_APP_ID=<app-id> DISCORD_BOT_TOKEN=<bot-token> npx tsx scripts/register-commands.ts

# For faster testing, register to a specific guild:
DISCORD_APP_ID=<app-id> DISCORD_BOT_TOKEN=<bot-token> GUILD_ID=<guild-id> npx tsx scripts/register-commands.ts
```

### 3. Configure environment

```bash
# Interactive — prompts for HMAC secret, App ID, proxy, etc.
./scripts/setup-env.sh
```

Or manually create `agent-service/.env`:

```env
AGENT_HMAC_SECRET=<same-key-as-gateway>
DISCORD_APP_ID=<your-app-id>

# Outbound proxy (required if Discord API is not directly accessible)
# HTTPS_PROXY=http://127.0.0.1:7897
# HTTP_PROXY=http://127.0.0.1:7897
```

### 4. Gateway deployment (Cloudflare Worker)

Configure `gateway/wrangler.toml`:

```toml
[vars]
DISCORD_PUBLIC_KEY = "<your-discord-public-key>"
DISCORD_APP_ID = "<your-app-id>"
ALLOWED_USERS = "<comma-separated-discord-user-ids>"
```

Deploy:

```bash
# One-click: checks secrets, builds, tests, deploys
./scripts/deploy-gateway.sh

# Or manually:
cd gateway
npx wrangler secret put AGENT_HMAC_SECRET    # Shared HMAC key (generate: openssl rand -hex 32)
npx wrangler secret put AGENT_ENDPOINT       # Your tunnel URL (e.g. https://agent-gw.yourdomain.com)
npx wrangler secret put DISCORD_BOT_TOKEN    # Discord bot token
npx wrangler deploy
```

Then set the **Interactions Endpoint URL** in your Discord Application settings to:
```
https://<your-worker>.workers.dev/webhook
```

### 5. Cloudflare Tunnel

```bash
# Interactive setup: creates tunnel + generates config
./scripts/setup-tunnel.sh

# Or manually:
cloudflared login
cloudflared tunnel create agent-gateway
cloudflared tunnel route dns agent-gateway agent-gw.yourdomain.com
```

Create `~/.cloudflared/config-agent-gateway.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: agent-gw.yourdomain.com
    service: http://127.0.0.1:8860
  - service: http_status:404
```

### 6. Run

```bash
# One-click: starts agent-service + tunnel, merged logs, Ctrl+C stops both
./scripts/start.sh
```

Or manually in two terminals:

```bash
# Terminal 1: Agent service
cd agent-service && npx tsx src/index.ts

# Terminal 2: Tunnel
cloudflared tunnel --config ~/.cloudflared/config-agent-gateway.yml run agent-gateway
```

Now use `/claude <prompt>` in Discord.

## Daily Operation

```bash
# Start everything (agent-service + tunnel, merged logs)
./scripts/start.sh

# Stop everything
./scripts/stop.sh

# Or manually:
curl http://127.0.0.1:8860/shutdown    # stop agent-service
curl http://127.0.0.1:8860/health      # check health
```

## Scripts Reference

All scripts are in `scripts/` and can be run from the project root.

| Script | Purpose | Usage |
|--------|---------|-------|
| `setup.sh` | Check prerequisites, install dependencies, build both packages | `./scripts/setup.sh` |
| `setup-env.sh` | Interactive `.env` generator (HMAC secret, App ID, proxy) | `./scripts/setup-env.sh` |
| `setup-tunnel.sh` | Create Cloudflare Tunnel and generate config file | `./scripts/setup-tunnel.sh` |
| `start.sh` | Start agent-service + tunnel together with merged logs | `./scripts/start.sh` |
| `stop.sh` | Gracefully stop all services | `./scripts/stop.sh` |
| `deploy-gateway.sh` | Validate secrets, build, test, deploy CF Worker | `./scripts/deploy-gateway.sh` |
| `register-commands.ts` | Register Discord slash commands | `npx tsx scripts/register-commands.ts` |

### First-time setup flow

```bash
./scripts/setup.sh           # 1. Install & build
./scripts/setup-env.sh       # 2. Configure .env
./scripts/setup-tunnel.sh    # 3. Create tunnel
./scripts/deploy-gateway.sh  # 4. Deploy CF Worker
./scripts/start.sh           # 5. Start services
```

## Development

```bash
# Agent service (hot reload)
cd agent-service && npm run dev

# Gateway (local wrangler dev)
cd gateway && npm run dev

# Run tests
cd agent-service && npm test
cd gateway && npm test
```

## Security Model

| Layer | Mechanism | Protects Against |
|-------|-----------|-----------------|
| 1 | Discord Ed25519 signature | Forged webhook requests |
| 2 | User ID whitelist | Unauthorized users |
| 3 | Cloudflare Tunnel | Public port exposure |
| 4 | HMAC-SHA256 + timestamp | Request forgery, replay attacks (5min window) |
| 5 | Path isolation | Access to sensitive directories (.ssh, .aws, .env, etc.) |

### Path Security

- **Allowed:** `~/Workspace`, `D:\Workspace` (configurable)
- **Blocked:** `~/.ssh`, `~/.aws`, `~/.claude`, `~/.gnupg`, `~/.config/gh`, `.env*`
- Path traversal (`../../`) is normalized before validation
- `~` is expanded to the real home directory

## Configuration Reference

### Agent Service Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENT_HMAC_SECRET` | Yes | - | Shared HMAC signing key |
| `DISCORD_APP_ID` | Yes | - | Discord Application ID |
| `DEFAULT_CWD` | No | `D:\Workspace` | Default working directory |
| `MAX_SESSIONS` | No | `5` | Max concurrent sessions |
| `SESSION_TIMEOUT_MS` | No | `1800000` (30min) | Session idle timeout |
| `HTTPS_PROXY` | No | - | Outbound HTTP proxy |

### Gateway Environment Variables (wrangler.toml + secrets)

| Variable | Type | Description |
|----------|------|-------------|
| `DISCORD_PUBLIC_KEY` | var | Ed25519 public key |
| `DISCORD_APP_ID` | var | Application ID |
| `ALLOWED_USERS` | var | Comma-separated user IDs |
| `AGENT_HMAC_SECRET` | secret | Shared HMAC key |
| `AGENT_ENDPOINT` | secret | Tunnel URL |
| `DISCORD_BOT_TOKEN` | secret | Bot token |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Discord shows "Application did not respond" | Agent service or tunnel not running | Start both services |
| 5xx with error code 1033 | Cloudflare Tunnel connector offline | Run `cloudflared tunnel run` |
| `fetch failed` in agent-service logs | Cannot reach discord.com | Configure `HTTPS_PROXY` in `.env` |
| `Unknown agent: Claude-Code` | N/A (fixed) | Agent name is now case-insensitive |
| `Working directory not allowed` | CWD outside allowed paths | Use a path under `~/Workspace` |

## License

MIT
