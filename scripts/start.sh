#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# AgentGateway — Start Services
#
# Starts both agent-service and cloudflared tunnel in the foreground.
# Logs are interleaved with prefixed labels. Ctrl+C stops both.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
TUNNEL_CONFIG="$HOME/.cloudflared/config-agent-gateway.yml"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Track child PIDs for cleanup
AGENT_PID=""
TUNNEL_PID=""

cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down...${NC}"

  # Graceful agent-service shutdown
  if [ -n "$AGENT_PID" ] && kill -0 "$AGENT_PID" 2>/dev/null; then
    curl -s http://127.0.0.1:8860/shutdown >/dev/null 2>&1 || true
    # Wait briefly, then force kill
    sleep 2
    kill "$AGENT_PID" 2>/dev/null || true
  fi

  # Stop tunnel
  if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi

  wait 2>/dev/null
  echo -e "${GREEN}All services stopped.${NC}"
  exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# ---- Pre-flight checks -------------------------------------------------------

# Check .env
if [ ! -f "$ROOT_DIR/agent-service/.env" ]; then
  echo -e "${RED}Missing agent-service/.env${NC}"
  echo "Run: ./scripts/setup-env.sh"
  exit 1
fi

# Check tunnel config
if [ ! -f "$TUNNEL_CONFIG" ]; then
  echo -e "${YELLOW}Warning: Tunnel config not found at $TUNNEL_CONFIG${NC}"
  echo "Run: ./scripts/setup-tunnel.sh"
  echo ""
  read -rp "Start agent-service only (without tunnel)? [Y/n] " SKIP_TUNNEL
  if [[ "$SKIP_TUNNEL" =~ ^[Nn]$ ]]; then
    exit 1
  fi
  TUNNEL_CONFIG=""
fi

# Check node_modules
if [ ! -d "$ROOT_DIR/agent-service/node_modules" ]; then
  echo "Installing agent-service dependencies..."
  cd "$ROOT_DIR/agent-service" && npm install
fi

# ---- Start agent-service -----------------------------------------------------

echo -e "${GREEN}=== AgentGateway Starting ===${NC}"
echo ""

echo -e "${CYAN}[agent]${NC} Starting agent-service..."
cd "$ROOT_DIR/agent-service"
npx tsx src/index.ts 2>&1 | sed "s/^/$(printf "${CYAN}[agent]${NC} ")/" &
AGENT_PID=$!

# Wait for agent-service to be ready
for i in {1..10}; do
  if curl -s http://127.0.0.1:8860/health >/dev/null 2>&1; then
    echo -e "${CYAN}[agent]${NC} ${GREEN}Ready${NC} on http://127.0.0.1:8860"
    break
  fi
  sleep 1
done

if ! curl -s http://127.0.0.1:8860/health >/dev/null 2>&1; then
  echo -e "${CYAN}[agent]${NC} ${RED}Failed to start${NC}"
  exit 1
fi

# ---- Start tunnel ------------------------------------------------------------

if [ -n "$TUNNEL_CONFIG" ]; then
  echo -e "${CYAN}[tunnel]${NC} Starting cloudflared..."
  cloudflared tunnel --config "$TUNNEL_CONFIG" run agent-gateway 2>&1 | sed "s/^/$(printf "${CYAN}[tunnel]${NC} ")/" &
  TUNNEL_PID=$!

  sleep 3
  echo -e "${CYAN}[tunnel]${NC} ${GREEN}Connected${NC}"
fi

# ---- Running -----------------------------------------------------------------

echo ""
echo -e "${GREEN}=== All services running ===${NC}"
echo "  Agent service:  http://127.0.0.1:8860"
if [ -n "$TUNNEL_CONFIG" ]; then
  echo "  Tunnel:         cloudflared → agent-gw"
fi
echo ""
echo "  Health check:   curl http://127.0.0.1:8860/health"
echo "  Stop:           Ctrl+C or ./scripts/stop.sh"
echo ""

# Wait for any child to exit
wait
