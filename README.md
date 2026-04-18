# AgentGateway v2

A universal AI CLI gateway that routes messages between instant messaging platforms and AI backends.

Connect your Discord or Telegram bot to Claude Code, Gemini, or any future AI CLI — with session isolation, message queuing, streaming edits, and production-grade error handling out of the box.

## Features

- Pluggable IM adapters (Discord, Telegram) and AI adapters (Claude Code, Gemini)
- Per-user session isolation with TTL cleanup and message queueing
- Streaming responses with throttled message edits
- Rate limiting (10 messages / user / minute) and fail-closed user whitelisting
- **Multi-modal attachments** — send images / documents / voice notes from Discord or Telegram and the gateway downloads them locally, then appends absolute paths to the AI prompt under an `[Attachments]` trailer so the AI CLI can `read` them. Configurable size limit (`MAX_ATTACHMENT_SIZE`, default 25 MB) and MIME whitelist (`ATTACHMENT_MIME_WHITELIST`, default `image/*, text/*, application/pdf, application/json`).

## Architecture

```
 ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
 │   Discord    │     │   Telegram   │     │    Slack     │  ... more IM adapters
 │  IMAdapter   │     │  IMAdapter   │     │  IMAdapter   │
 └──────┬───────┘     └──────┬───────┘     └──────┬───────┘
        │                    │                    │
        └────────┬───────────┴────────────────────┘
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
 ┌──────▼───────┐    ┌──────▼───────┐    ┌──────▼───────┐    ┌──────▼───────┐
 │  Claude Code │    │    Gemini    │    │    Codex     │    │   OpenCode   │
 │  AIAdapter   │    │  AIAdapter   │    │  AIAdapter   │    │  AIAdapter   │
 └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

**Key components:**

| Layer | Responsibility |
|-------|---------------|
| **IMAdapter** | Connects to a messaging platform, receives messages, sends replies. Handles platform-specific limits (Discord 2000 chars, Telegram 4096). |
| **Router** | Dispatches messages to the correct AI backend. Manages sessions, rate limiting (10 msg/min), message queuing when AI is busy, and streaming edit throttling. |
| **SessionManager** | Per-user isolated working directories, TTL-based cleanup (24h), message queue (max 20 / 50K chars). |
| **AIAdapter** | Spawns a local AI CLI process, streams output back. Supports session resume (Claude Code) and timeout (5 min). |

## Multi-AI Routing

A single bot can be connected to multiple AI backends simultaneously. Users switch between them using message prefixes:

```
/claude-code help me debug this function
/gemini translate this to Japanese
/codex refactor the auth module
```

**Session stickiness:** After switching, subsequent messages without a prefix continue using the last-selected AI. Each AI maintains its own session resume ID, so switching back picks up where you left off.

```
/gemini hello          → routes to Gemini, session sticks
follow-up question     → still Gemini (sticky)
/claude-code explain   → switches to Claude Code, shows 🔀 notice
another question       → still Claude Code
/gemini continue       → back to Gemini, resumes previous session
```

Configure via environment variables:

```bash
AI_BACKENDS=claude-code,gemini    # enable both
AI_DEFAULT=claude-code            # optional, first in list is default
```

## Supported Platforms

| IM Platform | Features |
|-------------|----------|
| **Discord** | Threads, reactions, message editing (streaming), DM & guild channels, image / file attachments |
| **Telegram** | Topics/threads, message editing (streaming), private & group chats, photo / document / voice attachments |
| **Slack** | Threads (thread_ts), message editing (chat.update), DM & channel mentions, Socket Mode |

| AI Backend | Session Resume | Streaming |
|------------|---------------|-----------|
| **Claude Code** | Yes | Yes (JSON stream) |
| **Gemini** | No | Yes (stdout) |
| **Codex** | No | Yes (stdout) |
| **OpenCode** | No | Yes (stdout) |

## Environment Variables

Enable an IM adapter by setting `<IM>_BOT_TOKEN`. At least one IM must be configured.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | one of IM | — | Discord bot token. Enables Discord adapter. Must match `[\w.-]+`. |
| `DISCORD_ALLOWED_USERS` | No | `""` (reject all) | Comma-separated Discord user IDs. Empty = reject all (fail-closed). |
| `TELEGRAM_BOT_TOKEN` | one of IM | — | Telegram bot token (`<id>:<token>`). Enables Telegram adapter. |
| `TELEGRAM_ALLOWED_USERS` | No | `""` (reject all) | Comma-separated Telegram user IDs. |
| `SLACK_BOT_TOKEN` | one of IM | — | Slack bot token (`xoxb-...`). Enables Slack adapter. |
| `SLACK_APP_TOKEN` | with Slack | — | Slack app-level token (`xapp-...`) for Socket Mode. |
| `SLACK_ALLOWED_USERS` | No | `""` (reject all) | Comma-separated Slack user IDs (e.g. `U12345678`). |
| `DEFAULT_CWD` | No | `/home/xyg/codebase` | Base directory for session-isolated working dirs. Must exist and be writable. |
| `AI_BACKENDS` | Yes | — | Comma-separated AI backends to enable: `claude-code`, `gemini`, `codex`, `opencode`. Users switch with `/claude-code`, `/gemini` prefix in chat. |
| `AI_DEFAULT` | No | first in list | Default AI backend (must be in `AI_BACKENDS`). |
| `CLAUDE_MODEL` | No | CLI default | Claude Code model override (e.g. `claude-opus-4-7`, `opus`, `sonnet`). |
| `CLAUDE_ALLOW_BASH` | No | `false` | Allow the Bash tool in Claude Code invocations. |
| `AUTO_REPLY_IN_DM` | No | `true` | Auto-reply in DMs without requiring @mention. |
| `AUTO_REPLY_IN_THREADS` | No | `true` | Auto-reply in threads without requiring @mention (Discord threads, Slack threads). |

## DM & Thread Auto-Reply

By default, the bot responds to messages in DMs and threads without requiring an @mention. In group channels, @mention is still required.

| Context | Discord | Telegram | Slack |
|---------|---------|----------|-------|
| **DM** | Auto-reply (no @mention needed) | Auto-reply (no @mention needed) | Auto-reply (no @mention needed) |
| **Thread** | Auto-reply (no @mention needed) | Auto-reply in topics (no @mention needed) | Auto-reply (no @mention needed) |
| **Channel** | @mention required | @bot_username required | @mention required |

Disable with `AUTO_REPLY_IN_DM=false` or `AUTO_REPLY_IN_THREADS=false`.

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available AI backends, usage examples, and current session AI. Does not invoke AI. |

## Reaction Feedback

On platforms that support it (Discord, Slack), the bot reacts to your message with:
- ⏳ when processing starts
- ✅ when processing completes successfully
- ❌ when an error occurs

Telegram does not support bot reactions. If the bot lacks reaction permissions, it fails silently.

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
3. Add the backend name to the `knownBackends` map in `src/index.ts`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start in development mode with hot-reload (tsx watch) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npm test` | Run smoke tests |

## License

Private.
