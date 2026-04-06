#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# AgentGateway — Interactive .env Generator
#
# Creates agent-service/.env with required configuration.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/agent-service/.env"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=== AgentGateway Environment Setup ==="
echo ""

if [ -f "$ENV_FILE" ]; then
  echo -e "${YELLOW}Existing .env found at:${NC} $ENV_FILE"
  read -rp "Overwrite? [y/N] " OVERWRITE
  if [[ ! "$OVERWRITE" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
  echo ""
fi

# ---- Collect values ----------------------------------------------------------

# HMAC Secret
read -rp "AGENT_HMAC_SECRET (shared with gateway, or press Enter to generate): " HMAC_SECRET
if [ -z "$HMAC_SECRET" ]; then
  HMAC_SECRET=$(openssl rand -hex 32)
  echo "  Generated: $HMAC_SECRET"
  echo -e "  ${YELLOW}Save this — you'll need the same value for the gateway secret.${NC}"
fi

# Discord App ID
read -rp "DISCORD_APP_ID: " APP_ID
while [ -z "$APP_ID" ]; do
  echo "  Required. Find it at https://discord.com/developers/applications"
  read -rp "DISCORD_APP_ID: " APP_ID
done

# Proxy
echo ""
echo "Outbound proxy (for Discord API access from restricted networks)."
echo "Leave blank if not needed."
read -rp "HTTPS_PROXY (e.g. http://127.0.0.1:7897): " PROXY

# Default CWD
read -rp "DEFAULT_CWD (default: D:\\Workspace): " CWD
CWD="${CWD:-D:\\Workspace}"

# ---- Write .env --------------------------------------------------------------

{
  echo "AGENT_HMAC_SECRET=$HMAC_SECRET"
  echo "DISCORD_APP_ID=$APP_ID"
  if [ -n "$PROXY" ]; then
    echo "HTTPS_PROXY=$PROXY"
    echo "HTTP_PROXY=$PROXY"
  fi
  if [ "$CWD" != 'D:\Workspace' ]; then
    echo "DEFAULT_CWD=$CWD"
  fi
} > "$ENV_FILE"

echo ""
echo -e "${GREEN}Written to:${NC} $ENV_FILE"
cat "$ENV_FILE" | sed 's/^/  /'

echo ""
echo -e "${YELLOW}Reminder:${NC} Set the same AGENT_HMAC_SECRET on the gateway:"
echo "  cd gateway && npx wrangler secret put AGENT_HMAC_SECRET"
