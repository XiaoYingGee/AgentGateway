#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# AgentGateway — Stop Services
#
# Gracefully stops agent-service and cloudflared tunnel.
# =============================================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=== AgentGateway Stop ==="

# ---- Stop agent-service ------------------------------------------------------

if curl -s --max-time 2 http://127.0.0.1:8860/health >/dev/null 2>&1; then
  echo "Stopping agent-service..."
  curl -s http://127.0.0.1:8860/shutdown >/dev/null 2>&1 || true
  sleep 2

  if curl -s --max-time 1 http://127.0.0.1:8860/health >/dev/null 2>&1; then
    echo -e "${YELLOW}Agent-service still running, force killing...${NC}"
    # Find and kill by port
    if command -v lsof &>/dev/null; then
      PID=$(lsof -ti :8860 2>/dev/null || true)
    elif command -v netstat &>/dev/null; then
      PID=$(netstat -ano 2>/dev/null | grep ':8860.*LISTENING' | awk '{print $NF}' | head -1 || true)
    else
      PID=""
    fi

    if [ -n "$PID" ]; then
      kill "$PID" 2>/dev/null || true
      echo "  Killed PID $PID"
    fi
  else
    echo -e "  ${GREEN}Agent-service stopped${NC}"
  fi
else
  echo "  Agent-service not running"
fi

# ---- Stop cloudflared --------------------------------------------------------

TUNNEL_PIDS=$(pgrep -f "cloudflared.*agent-gateway" 2>/dev/null || true)
if [ -n "$TUNNEL_PIDS" ]; then
  echo "Stopping cloudflared tunnel..."
  echo "$TUNNEL_PIDS" | xargs kill 2>/dev/null || true
  echo -e "  ${GREEN}Tunnel stopped${NC}"
else
  echo "  Tunnel not running"
fi

echo ""
echo -e "${GREEN}All services stopped.${NC}"
