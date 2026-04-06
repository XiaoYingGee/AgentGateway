#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# AgentGateway — Environment Setup
#
# Checks prerequisites and installs npm dependencies for both packages.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }

echo "=== AgentGateway Setup ==="
echo ""

# ---- Check prerequisites ----------------------------------------------------

echo "Checking prerequisites..."

MISSING=0

if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  ok "Node.js $NODE_VER"
else
  fail "Node.js not found (https://nodejs.org)"
  MISSING=1
fi

if command -v cloudflared &>/dev/null; then
  CF_VER=$(cloudflared --version 2>&1 | head -1)
  ok "cloudflared ($CF_VER)"
else
  warn "cloudflared not found — needed for tunnel (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)"
fi

if command -v claude &>/dev/null; then
  ok "Claude Code CLI ($(which claude))"
else
  # Check platform-specific paths
  CLAUDE_FOUND=0
  if [ "$(uname -s)" = "Darwin" ]; then
    for p in /usr/local/bin/claude /opt/homebrew/bin/claude "$HOME/.local/bin/claude"; do
      if [ -f "$p" ]; then
        ok "Claude Code CLI ($p)"
        CLAUDE_FOUND=1
        break
      fi
    done
  elif [ "$OS" = "Windows_NT" ] || uname -s | grep -qi mingw; then
    CLAUDE_WIN="$HOME/AppData/Local/Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe"
    if [ -f "$CLAUDE_WIN" ]; then
      ok "Claude Code CLI (WinGet)"
      CLAUDE_FOUND=1
    fi
  else
    for p in /usr/local/bin/claude "$HOME/.local/bin/claude"; do
      if [ -f "$p" ]; then
        ok "Claude Code CLI ($p)"
        CLAUDE_FOUND=1
        break
      fi
    done
  fi

  if [ "$CLAUDE_FOUND" -eq 0 ]; then
    warn "Claude Code CLI not found — install: npm install -g @anthropic-ai/claude-code"
  fi
fi

if command -v npx &>/dev/null; then
  ok "npx"
else
  fail "npx not found"
  MISSING=1
fi

echo ""

if [ "$MISSING" -eq 1 ]; then
  echo -e "${RED}Missing required tools. Please install them and re-run.${NC}"
  exit 1
fi

# ---- Install dependencies ----------------------------------------------------

echo "Installing gateway dependencies..."
cd "$ROOT_DIR/gateway" && npm install
ok "gateway"

echo ""
echo "Installing agent-service dependencies..."
cd "$ROOT_DIR/agent-service" && npm install
ok "agent-service"

# ---- Build check -------------------------------------------------------------

echo ""
echo "Running build check..."
cd "$ROOT_DIR/gateway" && npm run build 2>&1 && ok "gateway build" || fail "gateway build"
cd "$ROOT_DIR/agent-service" && npm run build 2>&1 && ok "agent-service build" || fail "agent-service build"

# ---- Done --------------------------------------------------------------------

echo ""
echo -e "${GREEN}=== Setup complete ===${NC}"
echo ""
echo "Next steps:"
echo "  1. Configure environment:  ./scripts/setup-env.sh"
echo "  2. Set up tunnel:          ./scripts/setup-tunnel.sh"
echo "  3. Deploy gateway:         ./scripts/deploy-gateway.sh"
echo "  4. Start services:         ./scripts/start.sh"
