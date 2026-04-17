# Deployment Guide — AgentGateway v2

## System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| **Node.js** | 20.x | 22.x LTS |
| **RAM** | 256 MB | 512 MB+ (depends on concurrent sessions) |
| **Disk** | 200 MB (node_modules + build) | 1 GB+ (session working directories grow with usage) |
| **AI CLI** | `claude` or `gemini` binary on PATH | — |
| **Network** | Outbound HTTPS to Discord/Telegram APIs | — |

## systemd Service

Create `/etc/systemd/system/agent-gateway.service`:

```ini
[Unit]
Description=AgentGateway v2
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agentgw
Group=agentgw
WorkingDirectory=/opt/agent-gateway/v2
ExecStart=/usr/bin/node dist/index.js
EnvironmentFile=/opt/agent-gateway/v2/.env
Restart=on-failure
RestartSec=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/agent-gateway/v2
PrivateTmp=true

# Resource limits
MemoryMax=1G
CPUQuota=200%

# Graceful shutdown (matches internal 30s timeout)
TimeoutStopSec=35

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agent-gateway
sudo journalctl -u agent-gateway -f
```

## Docker

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/

# The AI CLI (claude/gemini) must be available in PATH.
# Mount or install it in a derived image.

USER node
CMD ["node", "dist/index.js"]
```

Build and run:

```bash
docker build -t agent-gateway:v2 .
docker run -d --name agent-gateway \
  --env-file .env \
  --restart unless-stopped \
  agent-gateway:v2
```

> **Note:** The AI CLI binary (e.g. `claude`) must be accessible inside the container. Either install it in a derived image or bind-mount the host binary.

## Log Rotation

With systemd, journald handles rotation automatically. To tune:

```bash
# /etc/systemd/journald.conf.d/agent-gateway.conf
[Journal]
SystemMaxUse=500M
MaxRetentionSec=30day
```

If logging to files directly, use logrotate:

```
/var/log/agent-gateway/*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
}
```

## Monitoring

### Health indicators

- **Process alive**: systemd `is-active` check or Docker healthcheck
- **Session count**: Watch log lines containing `session created` / `session expired`
- **Error rate**: Monitor log lines with `[ERROR]` or ref IDs (`ref: xxxxxxxx`)
- **Queue depth**: Watch for `Queue full` messages — indicates sustained load

### Recommended alerts

| Signal | Condition | Severity |
|--------|-----------|----------|
| Process crash | systemd restart count > 3 in 5 min | Critical |
| AI timeout | `SIGTERM` / `SIGKILL` in logs | Warning |
| Queue overflow | `Queue full` messages | Warning |
| Rate limit hits | `Rate limited` messages spike | Info |

### Prometheus (optional)

For structured metrics, add a `/metrics` HTTP endpoint in a future version. Current monitoring relies on structured log analysis.
