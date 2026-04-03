#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Cloudflare Tunnel Setup Helper
#
# This script helps set up a Cloudflare Tunnel to expose the local Agent
# Service (127.0.0.1:7860) to the CF Worker gateway.
#
# Prerequisites:
#   - cloudflared installed (brew install cloudflared)
#   - Logged in to Cloudflare (cloudflared login)
# =============================================================================

TUNNEL_NAME="${TUNNEL_NAME:-agent-gateway}"
LOCAL_PORT="${LOCAL_PORT:-7860}"
LOCAL_HOST="127.0.0.1"

echo "=== AgentGateway Tunnel Setup ==="
echo ""

# Check cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo "Error: cloudflared is not installed."
    echo "Install with: brew install cloudflared"
    exit 1
fi

# Check if logged in
if ! cloudflared tunnel list &> /dev/null 2>&1; then
    echo "Not logged in to Cloudflare. Running login..."
    cloudflared login
fi

# Check if tunnel already exists
if cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
    echo "Tunnel '$TUNNEL_NAME' already exists."
    TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
    echo "Tunnel ID: $TUNNEL_ID"
else
    echo "Creating tunnel '$TUNNEL_NAME'..."
    cloudflared tunnel create "$TUNNEL_NAME"
    TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
    echo "Tunnel ID: $TUNNEL_ID"
fi

# Create/update config
CONFIG_DIR="$HOME/.cloudflared"
CONFIG_FILE="$CONFIG_DIR/config-${TUNNEL_NAME}.yml"

echo ""
echo "Writing tunnel config to: $CONFIG_FILE"
cat > "$CONFIG_FILE" << EOF
tunnel: $TUNNEL_ID
credentials-file: $CONFIG_DIR/${TUNNEL_ID}.json

ingress:
  - hostname: agent-gateway.yourdomain.com
    service: http://${LOCAL_HOST}:${LOCAL_PORT}
    originRequest:
      noTLSVerify: false
  - service: http_status:404
EOF

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Update the hostname in: $CONFIG_FILE"
echo "     Replace 'agent-gateway.yourdomain.com' with your actual domain"
echo ""
echo "  2. Add DNS route:"
echo "     cloudflared tunnel route dns $TUNNEL_NAME agent-gateway.yourdomain.com"
echo ""
echo "  3. Start the tunnel:"
echo "     cloudflared tunnel --config $CONFIG_FILE run $TUNNEL_NAME"
echo ""
echo "  4. (Optional) Set up as launchd service for auto-start:"
echo "     cloudflared service install"
echo ""
echo "  5. Set the AGENT_ENDPOINT in your CF Worker to:"
echo "     https://agent-gateway.yourdomain.com"
