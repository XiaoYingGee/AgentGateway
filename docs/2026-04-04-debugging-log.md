# AgentGateway 调试日志

> 日期: 2026-04-04
> 最后更新: 2026-04-06
> 状态: 端到端链路已打通，Discord 回调需代理

## 背景

2026-04-02 完成了 AgentGateway 的初始实现。2026-04-04 首次端到端测试时发现，
消息可以从 Discord → CF Worker → CF Tunnel → 本地 Node.js agent-service，
但 agent-service 调用 Claude Code 时报错，链路未走通。

---

## 已修复的问题

### 1. Claude Code SDK v2 移除了嵌入式 API

**问题**：`@anthropic-ai/claude-code` 从 v1 (1.0.128) 升级到 v2 (2.1.92) 后，
移除了 `sdk.mjs` 中的 `query()` 函数。v2 包仅包含 `cli.js`（CLI 入口）和
`sdk-tools.d.ts`（工具类型定义），不再提供 Node.js 可编程的 SDK 接口。

此外 v1 的 SDK 在 Node.js v25 上存在兼容性问题——内部打包的 `safe-buffer` 等旧库
在 Node 25 的 buffer API 下崩溃：
```
TypeError: Cannot read properties of undefined (reading 'prototype')
```

**修复**：adapter 从 SDK `query()` 调用改为 `child_process.execFile` 调用全局
安装的 `claude` CLI：
```ts
execFile(CLAUDE_CLI, [
  "-p", prompt,
  "--output-format", "json",
  "--max-turns", "30",
  "--allowedTools", "Read,Write,Edit,Bash,Glob,Grep",
  "--permission-mode", "bypassPermissions",
], { cwd: session.cwd, maxBuffer: 10 * 1024 * 1024 }, callback);
```

CLI 输出 JSON 格式的结果，adapter 解析 `result.result` 字段获取文本。

**文件变更**：
- `agent-service/src/adapters/claude-code.ts` — 完全重写
- `agent-service/package.json` — 移除 `@anthropic-ai/claude-code` 依赖

### 2. Discord interaction webhook 不需要 Bot Authorization

**问题**：`editDeferredResponse()` 和 `sendFollowUp()` 使用了
`Authorization: Bot <token>` 请求头。但 Discord interaction webhook 端点
(`/webhooks/{appId}/{token}/...`) 已通过 URL 中的 interaction token 认证，
不需要额外的 Bot Authorization header。

**修复**：移除 Authorization header。`DISCORD_BOT_TOKEN` 不再是必需的环境变量。

**文件变更**：
- `agent-service/src/discord.ts`
- `agent-service/src/index.ts`

### 3. Windows spawn ENOENT（路径含空格）

**问题**：`child_process.spawn()` 在 Windows 上对路径含空格的可执行文件
报 `ENOENT`，即使 `existsSync()` 确认文件存在。

**修复**：改用 `child_process.execFile()`，它能正确处理带空格的路径。

### 4. CWD 默认路径不存在

**问题**：`DEFAULT_CWD` 默认为 `~/Workspace`（即 `C:\Users\Ying Wu\Workspace`），
但实际 Workspace 在 `D:\Workspace`。Node.js 的 `execFile` 在 cwd 不存在时报
ENOENT，错误指向可执行文件路径，极其误导。

**修复**：
- `DEFAULT_CWD` 改为 `D:\Workspace`
- `allowedPaths` 增加 `D:\Workspace`

### 5. 改进日志输出

**问题**：原始日志无法区分是 Claude Code 调用失败还是 Discord 回调失败。

**修复**：`processInBackground()` 增加了详细的阶段日志：
```
[process] invoking adapter for prompt: "..."
[process] adapter returned N chars
[process] Discord response sent
```

### 6. agent-service 无法正常 shutdown

**问题**：进程启动后无法通过 Ctrl+C（SIGINT）或 SIGTERM 正常退出，必须手动按端口
查 PID 再 kill。原因有三：
1. Windows 上 Git Bash 的 `kill -INT` 对 Windows 原生 Node.js 进程信号传递不可靠
2. `server.close()` 仅停止接受新连接，不会关闭已有的 keep-alive 连接
3. 10 秒的 force-exit 超时太长

**修复**：
- 增加 `GET /shutdown` 端点（免 HMAC 认证，仅 localhost 可达），HTTP 方式触发关闭
- 调用 `server.closeAllConnections()` (Node 18.2+) 强制关闭所有现有连接
- force-exit 超时从 10s 缩短为 3s
- 设置 `server.keepAliveTimeout = 5000` 减少空闲连接
- `verify.ts` 中将 `/shutdown` 加入免验证白名单
- 增加 `isShuttingDown` 防重入标志

**文件变更**：
- `agent-service/src/index.ts` — 重写 shutdown 逻辑，增加 /shutdown 端点
- `agent-service/src/verify.ts` — /shutdown 免 HMAC 验证

**使用方式**：
```bash
# 启动
cd agent-service && npx tsx src/index.ts

# 优雅关闭
curl http://127.0.0.1:8860/shutdown
```

---

## 当前链路状态

```
Discord → CF Worker → CF Tunnel → agent-service → Claude Code CLI → Discord 回调
  ✅         ✅          ✅           ✅              ✅              ✅（需代理）
```

端到端验证已完成（2026-04-06）：
- CF Worker 正确验证 Discord 签名并转发请求
- CF Tunnel 成功桥接到本地 agent-service
- Claude Code CLI 被成功调用并返回结果
- Discord REST API 回调需要出站代理（中国大陆网络环境）

---

## 2026-04-06 第二轮调试

### 7. 请求验证加固

**问题**：`/invoke` 端点的字段验证过于宽松，存在以下安全隐患：
1. `~/.ssh` 等路径传入时，`~` 在 Windows 上不会被 `resolve()` 展开，绕过了路径黑名单
2. 危险 cwd 仅在 adapter 层异步拦截，`/invoke` 返回 202 accepted 后才报错
3. 数字类型的 `threadId`（如 `12345`）通过了 `!value` 检查
4. `null` 的 `interactionToken` 被接受，导致后续 Discord 回调静默失败
5. agent name 区分大小写，`Claude-Code` ≠ `claude-code`

**修复**：
- `validateCwd()` 增加 `~` 展开：`cwd.replace(/^~(?=[/\\]|$)/, HOME)`
- `/invoke` 新增 `validateRequest()` 函数，严格检查所有字段的类型和必填性
- `interactionToken` 升级为必填字段
- `/invoke` 在创建 session 前即校验 cwd，不合法直接返回 403
- agent name 查找改为 `toLowerCase()` 匹配

**文件变更**：
- `agent-service/src/adapters/claude-code.ts` — `validateCwd()` 增加 `~` 展开
- `agent-service/src/index.ts` — 新增 `validateRequest()`、早期 cwd 校验、agent name 大小写归一化
- `agent-service/test/claude-code.test.ts` — 新增 5 个 `~` 路径测试
- `agent-service/test/validate-request.test.ts` — 新增 19 个请求验证测试

**验证结果**（修复前 → 修复后）：

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| `cwd=~/.ssh` | 200 accepted（ENOENT） | 403 not allowed |
| `cwd=../../Windows/System32` | 200 accepted（异步拒绝） | 403 not allowed |
| `interactionToken=null` | 200 accepted（回调失败） | 400 invalid field |
| `threadId=12345`（数字） | 200 accepted | 400 invalid field |
| `agentName=Claude-Code` | 400 unknown agent | 200 accepted |

### 8. CF Tunnel 未运行导致 5xx

**问题**：Discord 交互返回 5xx Server Error，agent-service 完全没收到请求。
`wrangler tail` 抓到的日志：
```
Agent service error: 530 error code: 1033
```

**原因**：Cloudflare 错误码 1033 表示 Tunnel 连接器（cloudflared）未运行。
CF Worker 通过 Tunnel 地址转发请求时，Tunnel 那端无人应答。

**修复**：在本地启动 cloudflared：
```bash
cloudflared tunnel --config ~/.cloudflared/config-agent-gateway.yml run agent-gateway
```

成功后应看到 4 条 `Registered tunnel connection` 日志。

**注意**：`wrangler tail` 需要能访问 Cloudflare API。如果本地网络受限，
需要设置代理：
```bash
export HTTPS_PROXY=http://127.0.0.1:7897
npx wrangler tail --format pretty
```

### 9. Discord REST API 回调被墙

**问题**：Claude Code CLI 执行成功并返回结果，但 Discord 回调失败：
```
[process] adapter returned 54 chars
[process] adapter/discord error: fetch failed
[process] Discord callback also failed: fetch failed
```

**原因**：agent-service 通过 `fetch()` 调用 `https://discord.com/api/v10/...`
编辑 deferred 消息。在中国大陆网络环境下，discord.com 无法直接访问。
Node.js 原生 `fetch` 不会自动读取 `HTTP_PROXY` 环境变量。

**修复**：安装 `undici` 并在启动时设置全局代理分发器：
```bash
cd agent-service && npm install undici
```

`src/index.ts` 顶部增加：
```ts
const PROXY_URL = process.env["HTTPS_PROXY"] || process.env["HTTP_PROXY"];
if (PROXY_URL) {
  import("undici").then(({ ProxyAgent, setGlobalDispatcher }) => {
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
    console.log(`[agent-service] Global proxy set: ${PROXY_URL}`);
  });
}
```

`.env` 增加：
```
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
```

启动后应看到：
```
[agent-service] Global proxy set: http://127.0.0.1:7897
```

**文件变更**：
- `agent-service/src/index.ts` — 增加全局代理配置
- `agent-service/.env` — 增加 `HTTPS_PROXY` / `HTTP_PROXY`
- `agent-service/package.json` — 新增 `undici` 依赖

---

## 日常运行（更新）

```bash
# 终端 1：启动 Agent 服务（确保 .env 中配置了代理）
cd ~/Workspace/AgentGateway/agent-service && npx tsx src/index.ts

# 终端 2：启动 Tunnel
cloudflared tunnel --config ~/.cloudflared/config-agent-gateway.yml run agent-gateway

# 优雅关闭 Agent 服务
curl http://127.0.0.1:8860/shutdown
```

### 环境要求

| 组件 | 说明 |
|------|------|
| Node.js | v18+（推荐 v20+） |
| cloudflared | 本地安装，配置文件在 `~/.cloudflared/config-agent-gateway.yml` |
| 代理 | 需要出站代理访问 discord.com（中国大陆环境），配置在 `.env` |
| Claude Code CLI | 全局安装，`claude` 命令可用 |

---

## 全部变更文件清单

### 2026-04-04（首轮调试）

| 文件 | 变更 |
|------|------|
| `agent-service/src/adapters/claude-code.ts` | 重写：SDK → CLI execFile |
| `agent-service/src/discord.ts` | 移除 Bot Authorization header |
| `agent-service/src/index.ts` | 修复 DEFAULT_CWD，移除 BOT_TOKEN 依赖，改进日志，增加 /shutdown 端点 |
| `agent-service/src/verify.ts` | /shutdown 免 HMAC 验证 |
| `agent-service/package.json` | 移除 `@anthropic-ai/claude-code` 依赖 |

### 2026-04-06（第二轮调试）

| 文件 | 变更 |
|------|------|
| `agent-service/src/adapters/claude-code.ts` | `validateCwd()` 增加 `~` 展开 |
| `agent-service/src/index.ts` | 新增 `validateRequest()`、早期 cwd 校验、agent name 大小写归一化、全局代理配置 |
| `agent-service/.env` | 增加 `HTTPS_PROXY` / `HTTP_PROXY` |
| `agent-service/package.json` | 新增 `undici` 依赖 |
| `agent-service/test/claude-code.test.ts` | 新增 5 个 `~` 路径测试 |
| `agent-service/test/validate-request.test.ts` | 新增 19 个请求验证测试 |

---

## 后续改进建议（非阻塞）

1. **DEFAULT_CWD 应通过 .env 配置**：硬编码 `D:\Workspace` 不够灵活
2. **结构化日志**：记录 `{ userId, prompt, cwd, timestamp, result_length }` 用于审计
3. **流式进度反馈**：长任务期间定期更新 Discord 消息显示中间状态
4. **超长输出处理**：超过 Discord 字符限制时上传为 .md 文件附件
5. **优雅关闭**：处理 SIGTERM 时清理正在运行的 Claude Code 子进程
6. **会话上下文延续**：使用 `--resume` 参数让同一 thread 的多轮对话共享上下文
7. **Bash 命令安全过滤**：`bypassPermissions` 模式下增加危险命令黑名单
