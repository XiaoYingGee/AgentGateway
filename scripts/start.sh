#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Load .env if present
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
  echo "[start] Loaded .env"
fi

# Validate required vars
if [[ -z "${BOT_TOKEN:-}" ]]; then
  echo "[start] ERROR: BOT_TOKEN is not set. Copy .env.example to .env and configure it." >&2
  exit 1
fi

# Install dependencies if needed
if [[ ! -d node_modules ]]; then
  echo "[start] Installing dependencies..."
  npm ci --production=false
fi

# Build
echo "[start] Building..."
npm run build

# Start
echo "[start] Starting AgentGateway v2..."
exec node dist/index.js
