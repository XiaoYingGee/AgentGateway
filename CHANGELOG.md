# Changelog — AgentGateway v2 Audit Fixes

## Unreleased

### Multi-modal attachments

- New: `IncomingMessage.attachments?: InboundAttachment[]` on `src/core/types.ts`
- New module `src/utils/attachments.ts` — streaming download with size cap (`MAX_ATTACHMENT_SIZE`, default 25 MB) and fail-closed MIME whitelist (`ATTACHMENT_MIME_WHITELIST`, default `image/,text/,application/pdf,application/json`). Files land under `${DEFAULT_CWD}/.attachments/<sessionId>/<timestamp>-<safe-filename>` with sanitized filenames and path-traversal defenses.
- Discord adapter parses `message.attachments` (Collection) into `InboundAttachment[]`.
- Telegram adapter handles `photo`, `document`, and `voice` messages, resolving file URLs via `bot.api.getFile`.
- Router downloads attachments before invoking the AI; failures (size / MIME / network) reply with `❌ <reason>` and skip the AI call entirely. On success, an `\n\n[Attachments]\n- <abs-path> (<mime>, <size>)` trailer is appended to the prompt so the AI CLI can `read` the files.
- Tests: new `tests/attachments.test.ts` covering sanitization, MIME enforcement, size guards, and download paths; new router integration tests for the attachment pipeline (success path + rejected MIME).
- Docs: README Features section + IM table updated; `.env.example` gains the two new variables.

## Post-launch Hardening (Round 5)

### P1: Startup orphan session cleanup
- **File**: `core/session.ts`
- SessionManager constructor now cleans all directories under `.sessions/` on startup
- Memory Map is empty at boot, so all leftover dirs from previous runs are orphans
- Fail-safe: individual `rmSync` failures logged as warnings, never thrown

### P2: Rate limit Map empty array cleanup
- **File**: `core/router.ts`
- After pruning expired timestamps, empty arrays are deleted from the `rateLimits` Map
- Re-created on next message from that user — prevents unbounded Map growth from one-time visitors

### P3: Shutdown force-kill child processes
- **Files**: `adapters/ai/claude-code.ts`, `core/types.ts`, `core/router.ts`
- `ClaudeCodeAdapter` tracks active child processes in a `Set<ChildProcess>`
- New `killAll()` method sends SIGTERM to all active children
- `Router.stop()` calls `aiAdapter.killAll?.()` after the 30s shutdown timeout
- `AIAdapter` interface gains optional `killAll?(): void`

### P4: Router end-to-end integration tests
- **File**: `tests/router.test.ts` (new)
- Mock IM + Mock AI adapters for full pipeline testing
- Tests: message routing (IM→AI→IM reply), R1 nested drain (3 concurrent messages), R10 rate limit (11th rejected), P5 statusCheck, P2 cleanup verification
- 5 new integration tests (35 total across both test files)

### P5: Telegram long-poll health status
- **Files**: `adapters/im/base.ts`, `adapters/im/telegram.ts`, `core/types.ts`, `core/router.ts`
- `BaseIMAdapter` abstract class with `isHealthy(): boolean` (default: true)
- `TelegramAdapter` extends `BaseIMAdapter`, sets `healthy = false` on long-poll crash
- `IMAdapter` interface gains optional `isHealthy?(): boolean`
- `Router.statusCheck()` returns health status of all registered IM adapters

## Round 4 Fixes

### 🔴 Critical

#### R1: Router drain/markBusy atomicity
- **File**: `core/router.ts`
- Replaced fire-and-forget recursive `processMessage` with synchronous `while(true)` drain loop
- Session stays busy throughout queue processing; `markFree` only called when queue is empty
- Eliminates race window where incoming messages could be lost between markFree→drain→markBusy

#### R2: Telegram editMessage parameter fix (SendResult)
- **Files**: `core/types.ts`, `adapters/im/discord.ts`, `adapters/im/telegram.ts`, `core/router.ts`
- `sendMessage` now returns `SendResult { messageId, chatId, threadId? }` instead of bare string
- `editMessage` signature changed to `(target: SendResult, text: string)` — always receives the correct chatId
- Fixes fatal bug where Telegram editMessage received threadId instead of chatId

#### R3: Telegram connect startup validation
- **File**: `adapters/im/telegram.ts`
- `connect()` now calls `await this.bot.init()` to validate token before starting long-poll
- `bot.start()` runs in background with `.catch()` — crash logged, doesn't kill process

#### R4: TTL + rm TOCTOU race fix
- **File**: `core/session.ts`
- Session cwd now includes UUID suffix: `.sessions/<hash>-<uuid>/`
- New sessions for the same key get physically different directories
- Eliminates race where `rm` of expired session could delete a newly created session's directory

### 🔴 Production-ready

#### R5: Graceful shutdown
- **Files**: `core/router.ts`, `core/session.ts`
- `stop()` disconnects all IM adapters first (stops accepting new messages)
- Waits up to 30s for busy sessions to complete before destroying
- `SessionManager.hasActiveSessions()` added to check for in-flight work

### 🟡 Medium

#### R6: Claude Bash permission restriction
- **File**: `adapters/ai/claude-code.ts`
- Default `--allowedTools` no longer includes `Bash`
- Set `CLAUDE_ALLOW_BASH=true` env var to re-enable Bash tool

#### R7: Error message sanitization
- **File**: `core/router.ts`
- User-facing errors now show only `Something went wrong (ref: <8-char-id>)`
- Full error details logged with matching ref id for debugging

#### R8: Stream edit serialization
- **File**: `core/router.ts`
- Streaming edit calls chained via `editChain = editChain.then(...)` promise chain
- Prevents out-of-order delivery when edits overlap

#### R9: Test coverage for new features
- **File**: `tests/smoke.test.ts`
- Added 6 new tests (30 total):
  - Stream edit fallback (editMessage throws → sendMessage)
  - TTL sweep + rm cleanup (expired session directory removed)
  - drain/markBusy atomicity (busy state, enqueue, drain, markFree cycle)
  - Cross-platform session key independence (Discord vs Telegram)
  - hasActiveSessions (idle and busy states)

#### R10: Per-user rate limiting
- **File**: `core/router.ts`
- Sliding window token bucket: 10 messages per minute per user
- Exceeding limit returns "Rate limit exceeded" message

#### R11: Configuration validation
- **File**: `index.ts`
- Discord `BOT_TOKEN` regex validation
- Telegram `TELEGRAM_BOT_TOKEN` format check (`<id>:<token>`)
- `DEFAULT_CWD` existence and write-permission checks
- Clear error messages on validation failure

## Round 3 Fixes

### S-1: Thread editMessage fix + first segment fallback
- **Files**: `core/router.ts`, `adapters/im/discord.ts`
- Placeholder lives in `threadId ?? chatId`, edit uses that channelId (not parent)
- Streaming edits use `placeholderChannelId`
- Final edit failure falls back to `sendMessage` so first segment isn't lost

### S-2: Queue size limits
- **File**: `core/session.ts`, `core/router.ts`
- `MAX_QUEUE=20`, `MAX_QUEUE_CHARS=50000` — rejects with user-visible message on overflow
- Overflow flag carried into drain to notify AI of dropped messages

### S-3: Disk cleanup on session sweep
- **File**: `core/session.ts`
- TTL-expired sessions now `rm -rf` their cwd directory (async, errors caught)

### M-1: Queued messages replyToId fix
- **Files**: `core/session.ts`, `core/router.ts`
- Queue stores `{ text, replyToId, threadId }` per message
- `drain()` returns last message's metadata for synthetic message

### M-2: Drain merge format as explicit instruction
- **File**: `core/session.ts`
- Single message: raw text. Multiple: `"The user sent N messages..."` with `### Message N` headers

### M-3: UTF-16 surrogate pair boundary check
- **File**: `utils/messages.ts`
- Hard-split checks if previous char is a high surrogate (0xD800–0xDBFF), backs up one position

### M-6: mkdirSync error handling
- **File**: `core/router.ts`
- `handleMessage` wrapped in try/catch; errors reported to user via `sendMessage`

### L-1: editMessage console.warn
- **File**: `adapters/im/discord.ts`
- `editMessage` catch block now logs `console.warn` with error details

### L-3: Timeout aborted flag
- **File**: `adapters/ai/claude-code.ts`
- `aborted` flag set after timeout reject; `stdout.on("data")` short-circuits when set

## Critical (S-level)

### S4: Subprocess timeout three-tier fallback
- **File**: `adapters/ai/claude-code.ts`
- SIGTERM on timeout → SIGKILL after 5s → immediate Promise reject (no waiting for `close`)
- Added `child.on("error")` to handle spawn failures
- Used `settled` guard to prevent double-resolve

### S3: InboundMessage explicit chatId
- **Files**: `core/types.ts`, `adapters/im/discord.ts`, `core/router.ts`
- Added `chatId: string` to `InboundMessage` (required field)
- Discord adapter sets chatId = parent channelId for threads (not threadId)
- Removed `extractChatId()` string-splitting hack from Router

### S5: Multi-session isolated cwd
- **Files**: `core/session.ts`, `core/router.ts`, `adapters/ai/claude-code.ts`
- SessionManager creates `<baseCwd>/.sessions/<sha256(key)>/` per session
- Router passes session-specific cwd to AI adapter
- Directories created lazily on first access

### S1: Per-session message queue (FIFO)
- **Files**: `core/session.ts`, `core/router.ts`
- Busy sessions now enqueue messages instead of rejecting
- After current turn completes, queued messages are combined and processed
- Strategy: join with `---` separator (documented in code)

### S2: Streaming edit + throttle
- **Files**: `core/types.ts`, `adapters/im/discord.ts`, `core/router.ts`
- IMAdapter gains optional `editMessage()` method; `sendMessage` returns message ID
- Discord adapter implements `editMessage`
- Router sends placeholder message, edits with streaming text (1500ms throttle)
- Typing indicator throttled to 8s

### S6: Router startup AI assertion
- **File**: `core/router.ts`
- `start()` throws if no AI adapter registered

## Elevated to Critical

### M2→S: Bot whitelist + fail-closed
- **File**: `adapters/im/discord.ts`
- `allowedUsers` empty → reject ALL messages (fail-closed)
- Both bots and humans must be explicitly listed
- Disabled default mention parsing: `allowedMentions: { parse: [] }`

### M1: Session key user dimension
- **File**: `adapters/im/discord.ts`
- Guild: `discord:guild:<G>:channel:<C>:user:<U>`
- DM: `discord:dm:user:<U>`
- Comment noting future configurable shared-session strategy

## Medium (M-level)

### M3: Outer try/catch on Discord message handler
- **File**: `adapters/im/discord.ts`
- `.catch()` on `onDiscordMessage()` call prevents unhandled rejection

### M4: Internal message splitting in sendMessage flow
- **File**: `core/router.ts`
- Router always splits via `splitMessage()` before sending

### M5: Code block language tag preservation
- **File**: `utils/messages.ts`
- `repairCodeBlocks` now tracks the opening fence (e.g. `` ```python ``)
- Split continuation segments reopen with the same language tag

### M6: Session TTL (24h default)
- **File**: `core/session.ts`
- Sweep runs every 10 minutes, expires idle sessions after `ttlMs`
- Timer is `.unref()`'d to not block process exit

### M7: Resume failure fallback
- **File**: `core/router.ts`
- If AI invocation error contains "resume", clears `aiSessionId`
- Next message will start a fresh session

### M8: stream-json error transparency
- **File**: `adapters/ai/claude-code.ts`
- Handles `event.type === "error"` and `result.is_error`
- Error messages surfaced in rejection

### M9: stderr tail in error messages
- **File**: `adapters/ai/claude-code.ts`
- Captures last 1500 bytes of stderr
- On non-zero exit, appends last 5 lines to error message

### M10: Duplicate adapter registration throws
- **File**: `core/router.ts`
- `registerIM()` and `registerAI()` throw on duplicate registration
