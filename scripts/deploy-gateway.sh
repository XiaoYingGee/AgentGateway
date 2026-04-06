#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# AgentGateway — Deploy Gateway to Cloudflare Workers
#
# Checks that secrets are configured, builds, and deploys.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
GATEWAY_DIR="$ROOT_DIR/gateway"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }

echo "=== Deploy Gateway ==="
echo ""

cd "$GATEWAY_DIR"

# ---- Check wrangler ----------------------------------------------------------

if ! command -v npx &>/dev/null; then
  fail "npx not found"
  exit 1
fi

# ---- Check secrets -----------------------------------------------------------

echo "Checking configured secrets..."
SECRETS=$(npx wrangler secret list 2>/dev/null || echo "[]")

MISSING=0
for SECRET in AGENT_HMAC_SECRET AGENT_ENDPOINT DISCORD_BOT_TOKEN; do
  if echo "$SECRETS" | grep -q "\"$SECRET\""; then
    ok "$SECRET"
  else
    fail "$SECRET not set — run: npx wrangler secret put $SECRET"
    MISSING=1
  fi
done

echo ""

if [ "$MISSING" -eq 1 ]; then
  echo -e "${RED}Missing secrets. Set them before deploying.${NC}"
  exit 1
fi

# ---- Build -------------------------------------------------------------------

echo "Building..."
npm run build 2>&1
ok "Build passed"

# ---- Run tests ---------------------------------------------------------------

echo "Running tests..."
npm test 2>&1
ok "Tests passed"

# ---- Deploy ------------------------------------------------------------------

echo ""
read -rp "Deploy to Cloudflare Workers? [Y/n] " CONFIRM
if [[ "$CONFIRM" =~ ^[Nn]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo "Deploying..."
npx wrangler deploy 2>&1

echo ""
echo -e "${GREEN}=== Gateway deployed ===${NC}"
