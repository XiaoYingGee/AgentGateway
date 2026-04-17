# AgentGateway v2

A universal AI CLI gateway that routes messages between instant messaging platforms and AI backends.

Connect your Discord or Telegram bot to Claude Code, Gemini, or any future AI CLI — with session isolation, message queuing, streaming edits, and production-grade error handling out of the box.

## Architecture

```
 ┌──────────────┐     ┌──────────────┐
 │   Discord    │     │   Telegram   │       ... more IM adapters
 │  IMAdapter   │     │  IMAdapter   │
 └──────┬───────┘     └──────┬───────┘
        │                    │
        └────────┬───────────┘
                 │
         ┌───────▼────────┐
         │     Router      │
         │                 │
         │  • Rate Limit   │
         │  • Session Mgmt │
         │  • Queue/Drain  │
         │  • Stream Edit  │
         └───────┬────────┘
                 │
        ┌────────┴───────────┐
        │                    │
 ┌──────▼───────┐    ┌──────▼───────┐
 │  Claude Code │    │    Gemini    │       ... more AI adapters
 │  AIAdapter   │    │  AIAdapter   │
 └──────────────┘    └──────────────┘
```

**Key components:**

| Layer | Responsibility |
|-------|---------------|
| **IMAdapter** | Connects to a messaging platform, receives messages, sends replies. Handles platform-specific limits (Discord 2000 chars, Telegram 4096). |
| **Router** | Dispatches messages to the correct AI backend. Manages sessions, rate limiting (10 msg/min), message queuing when AI is busy, and streaming edit throttling. |
| **SessionManager** | Per-user isolated working directories, TTL-based cleanup (24h), message queue (max 20 / 50K chars). |
| **AIAdapter** | Spawns a local AI CLI process, streams output back. Supports session resume (Claude Code) and timeout (5 min). |

## Supported Platforms

| IM Platform | Features |
|-------------|----------|
| **Discord** | Threads, reactions, message editing (streaming), DM & guild channels |
| **Telegram** | Topics/threads, message editing (streaming), private & group chats |

| AI Backend | Session Resume | Streaming |
|------------|---------------|-----------|
| **Claude Code** | Yes | Yes (JSON stream) |
| **Gemini** | No | Yes (stdout) |

## Environment Variables

Enable an IM adapter by setting `<IM>_BOT_TOKEN`. At least one IM must be configured.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | one of IM | — | Discord bot token. Enables Discord adapter. Must match `[\w.-]+`. |
| `DISCORD_ALLOWED_USERS` | No | `""` (reject all) | Comma-separated Discord user IDs. Empty = reject all (fail-closed). |
| `TELEGRAM_BOT_TOKEN` | one of IM | — | Telegram bot token (`<id>:<token>`). Enables Telegram adapter. |
| `TELEGRAM_ALLOWED_USERS` | No | `""` (reject all) | Comma-separated Telegram user IDs. |
| `DEFAULT_CWD` | No | `/home/xyg/codebase` | Base directory for session-isolated working dirs. Must exist and be writable. |
| `AI_BACKEND` | No | `claude-code` | AI backend to use: `claude-code` or `gemini`. |
| `CLAUDE_MODEL` | No | CLI default | Claude Code model override (e.g. `claude-opus-4-7`, `opus`, `sonnet`). |
| `CLAUDE_ALLOW_BASH` | No | `false` | Allow the Bash tool in Claude Code invocations. |

**Legacy (deprecated, still honored with warning):** `BOT_TOKEN` → use `DISCORD_BOT_TOKEN`; `ALLOWED_USERS` → use `DISCORD_ALLOWED_USERS`.

## Quick Start

**1. Install dependencies**

```bash
npm install
```

**2. Configure environment**

```bash
cp .env.example .env
# Edit .env — set at least DISCORD_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) and allowed users
```

**3. Run**

```bash
# Development (hot-reload)
npm run dev

# Production
npm run build && npm start
```

## Extending

### Add a new IM adapter

1. Create `src/adapters/im/your-platform.ts`
2. Implement the `IMAdapter` interface from `src/core/types.ts`:
   ```typescript
   interface IMAdapter {
     platform: string;
     accountId: string;
     connect(): Promise<void>;
     disconnect(): Promise<void>;
     sendMessage(params: { chatId: string; text: string; threadId?: string; replyToId?: string }): Promise<SendResult>;
     sendTyping?(chatId: string): Promise<void>;
     editMessage?(target: SendResult, text: string): Promise<void>;
     onMessage(handler: (msg: InboundMessage) => void): void;
     capabilities?: { threads?: boolean; reactions?: boolean };
   }
   ```
3. Register it in `src/index.ts`:
   ```typescript
   router.registerIM(new YourPlatformAdapter({ token, allowedUsers }));
   ```

### Add a new AI adapter

1. Create `src/adapters/ai/your-ai.ts`
2. Implement the `AIAdapter` interface from `src/core/types.ts`:
   ```typescript
   interface AIAdapter {
     name: string;
     supportsResume: boolean;
     invoke(params: {
       prompt: string;
       sessionId?: string;
       cwd?: string;
       onChunk?: (text: string) => void;
     }): Promise<{ text: string; sessionId?: string; exitCode: number }>;
   }
   ```
3. Add the backend option in `src/index.ts` under the `AI_BACKEND` switch.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start in development mode with hot-reload (tsx watch) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npm test` | Run smoke tests (30 tests) |

## License

Private.
