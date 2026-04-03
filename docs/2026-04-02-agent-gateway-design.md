# AgentGateway 设计文档

> 日期: 2026-04-02
> 状态: 已确认，待实施

## 概述

AgentGateway 是一个通用的 AI Agent 网关，部署在 Cloudflare 边缘网络上，将本地/远程的 AI Agent（Claude Code、OpenClaw、Codex 等）通过统一的方式接入 IM 平台（Discord、Telegram 等），实现全球调用。

首期实现：**CF Worker 网关 + Discord + Claude Code**。

## 核心需求

- 通过 Discord 远程调用 Mac 本地的 Claude Code，具备完整能力（读写文件、执行命令、操作 git）
- 严格的安全控制——白名单用户、签名验证、路径隔离
- Thread 维度的会话管理，支持上下文连续对话
- 可扩展：未来支持多 Agent、多 IM 平台、多节点（Mac + VM）

## 架构

```
Discord User
    ↓ interaction/message
Discord API
    ↓ webhook (POST)
┌──────────────────────────────────┐
│  CF Worker: agent-gateway        │
│  ├─ Discord webhook Ed25519 验证  │
│  ├─ 用户白名单 (Discord User ID)  │
│  ├─ 限流 (per-user per-minute)   │
│  ├─ Agent 路由                    │
│  └─ 请求转发 + HMAC 签名          │
└──────────────────────────────────┘
    ↓ HTTPS + HMAC-SHA256 签名
    CF Tunnel (加密隧道)
    ↓
┌──────────────────────────────────┐
│  Local Agent Service (Node.js)   │
│  ├─ HMAC 签名验证 (防伪造)        │
│  ├─ 会话管理 (thread → session)   │
│  ├─ Agent 适配器                  │
│  │   ├─ Claude Code SDK          │
│  │   └─ (未来: OpenClaw, Codex)  │
│  └─ Discord REST API 回调        │
└──────────────────────────────────┘
    Mac / VM (可多节点)
```

## 安全设计（五层防御）

| 层级 | 机制 | 说明 |
|------|------|------|
| 第一层 | Discord webhook Ed25519 签名验证 | 确保请求来自 Discord，非伪造 |
| 第二层 | User ID 白名单 | 仅允许指定的几个受信任用户 |
| 第三层 | Cloudflare Tunnel | 加密隧道，本地服务不暴露公网端口 |
| 第四层 | HMAC-SHA256 请求签名 + 时间戳 | 即使 Tunnel 被突破也无法伪造请求，5 分钟防重放 |
| 第五层 | 工作目录隔离 | Claude Code 限制在 `~/Workspace/*`，拦截敏感路径 |

### 本地 Agent 服务安全约束

| 约束 | 实现 |
|------|------|
| 仅本地监听 | `127.0.0.1:7860` |
| 请求签名 | HMAC-SHA256 + 时间戳（>5 分钟拒绝） |
| 工作目录限制 | `allowedPaths` 白名单（`~/Workspace/*`） |
| 敏感路径拦截 | 黑名单：`~/.ssh`, `~/.aws`, `~/.claude`, `~/.env` 等 |
| 并发限制 | 最大 5 个活跃会话 |
| 会话超时 | 30 分钟无交互自动销毁 |
| 输出截断 | 防止 Discord API 溢出 |

## CF Worker（网关层）

### 技术选型
- Cloudflare Worker + Hono（轻量路由框架）
- Cloudflare KV（限流计数）

### 核心流程
1. 接收 Discord webhook POST → 验证 Ed25519 签名
2. 解析 interaction → 提取 user ID、command、thread ID
3. 查白名单 → 拒绝则返回 "Unauthorized"
4. 限流检查（KV 计数器，per-user per-minute）
5. 构造内部请求，附加 HMAC-SHA256 签名 + 时间戳
6. 转发到对应 Agent 节点（通过 Tunnel 地址）
7. 先回 `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`（Discord 3 秒超时），Agent 处理完后编辑消息

### Discord 交互方式
- Slash command：`/claude <prompt>` — 发起新对话
- 在 thread 中继续对话保持上下文
- 自动创建 thread 维护会话
- 长消息分段发送（每段 ≤1900 字符）

### 环境变量
| 变量 | 用途 |
|------|------|
| `DISCORD_PUBLIC_KEY` | Webhook Ed25519 签名验证 |
| `DISCORD_BOT_TOKEN` | 回复消息用 |
| `DISCORD_APP_ID` | Discord 应用 ID |
| `ALLOWED_USERS` | 白名单 User ID 列表（逗号分隔） |
| `AGENT_HMAC_SECRET` | 与本地 Agent 服务共享的签名密钥 |
| `AGENT_ENDPOINTS` | Agent 节点地址映射（JSON） |

## 本地 Agent 服务

### 技术选型
- Node.js + Hono + Claude Code SDK (`@anthropic-ai/claude-code`)

### 模块设计

**请求验证层**
- 验证 HMAC-SHA256 签名（共享密钥）
- 验证时间戳（拒绝 >5 分钟的请求）
- 仅监听 `127.0.0.1:7860`

**会话管理器**
- `Map<threadId, ClaudeSession>` 内存维护活跃会话
- 每个 Discord thread 对应一个 Claude Code 会话实例
- 空闲超时自动销毁（30 分钟）
- 最大并发 5 个会话

**Agent 适配器（插件化）**
```ts
interface AgentAdapter {
  name: string
  invoke(prompt: string, session?: SessionContext): AsyncIterable<string>
  destroy(sessionId: string): void
}
```

首期只实现 `claude-code` 适配器：
- 通过 `@anthropic-ai/claude-code` SDK 调用
- 传入 `cwd`（工作目录，受白名单限制）
- 流式输出累积后通过 Discord REST API 更新消息

**响应回调**
- 通过 Discord Bot Token + REST API 编辑 deferred 消息
- 长输出分段（≤1900 字符/段）
- 代码块自动 markdown 格式化
- 超长输出截断 + 提示

## 项目结构

```
~/Workspace/AgentGateway/
├── gateway/                    # CF Worker（网关）
│   ├── src/
│   │   ├── index.ts           # 入口，路由
│   │   ├── discord.ts         # Webhook 验证 + 交互解析
│   │   ├── auth.ts            # 白名单鉴权 + 限流
│   │   ├── signing.ts         # HMAC 签名生成
│   │   └── types.ts           # 共享类型
│   ├── wrangler.toml
│   ├── package.json
│   └── tsconfig.json
│
├── agent-service/              # 本地 Agent 服务
│   ├── src/
│   │   ├── index.ts           # 入口，HTTP 服务器
│   │   ├── verify.ts          # HMAC 签名验证
│   │   ├── session.ts         # 会话管理器
│   │   ├── discord.ts         # Discord REST API 回调
│   │   ├── adapters/
│   │   │   ├── base.ts        # 适配器接口
│   │   │   └── claude-code.ts # Claude Code SDK 适配器
│   │   └── types.ts
│   ├── package.json
│   └── tsconfig.json
│
├── scripts/
│   ├── register-commands.ts   # Discord slash command 注册
│   └── setup-tunnel.sh        # CF Tunnel 配置辅助
│
└── docs/
    └── 2026-04-02-agent-gateway-design.md  # 本文档
```

## 部署流程

### 一次性配置
1. 创建 Discord Application + Bot，获取 token 和 public key
2. 运行 `register-commands.ts` 注册 `/claude` slash command
3. `wrangler deploy` 部署 CF Worker
4. 在 Discord App 设置中填入 Worker URL 作为 Interactions Endpoint
5. 本地安装 `cloudflared`，创建 Tunnel 指向 `127.0.0.1:7860`

### 日常运行
```bash
# 终端 1：启动 Agent 服务
cd ~/Workspace/AgentGateway/agent-service && npm start

# 终端 2：启动 Tunnel（或配置为 launchd 开机自启）
cloudflared tunnel run agent-gateway
```

## 首期不做（YAGNI）

- 多 Agent 路由（只做 Claude Code）
- 多 IM 平台（只做 Discord）
- Web 管理界面
- 消息持久化 / 日志存储
- 文件上传 / 下载
- 语音消息

## 未来扩展方向

- 添加 OpenClaw、Codex 等 Agent 适配器
- 接入 Telegram、Slack 等 IM 平台
- 多节点负载均衡（Mac + VM）
- 审计日志（Cloudflare D1 / R2）
