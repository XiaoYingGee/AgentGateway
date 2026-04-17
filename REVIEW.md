# Code Review: Features 1-3

**Date:** 2026-04-17
**Reviewer:** Claude Opus 4 (automated)
**Scope:** DM/Thread auto-reply, /help command, reaction feedback

---

## Summary

3 features implemented across 8 files with 11 new tests. All existing 61 tests continue to pass. Total: 72 tests.

## Findings & Fixes

### BUG: Slack duplicate event processing (Fixed)
**File:** `src/adapters/im/slack.ts`
**Issue:** When `autoReplyInThreads` is enabled, a thread message with @mention would trigger both `onSlackMessage` (thread auto-reply path) and `onSlackMention` (app_mention event), causing the message to be processed twice.
**Fix:** Added early return in `onSlackMention` when the message is in a thread and `autoReplyInThreads` is enabled, since `onSlackMessage` already handles it.

### BUG: parseCommand too permissive (Fixed)
**File:** `src/utils/command.ts`
**Issue:** The regex `\/?(help)` matched bare "help" without a slash, meaning a user sending "help" as a normal message would get the help response instead of the message being sent to AI.
**Fix:** Changed regex to require `/` prefix: `\/(help)`.

### SECURITY: Telegram RegExp injection (Fixed)
**File:** `src/adapters/im/telegram.ts`
**Issue:** Bot username was interpolated directly into `new RegExp()` for mention stripping. If the username contained regex metacharacters, this could cause unexpected behavior or ReDoS.
**Fix:** Replaced `RegExp` with `String.split().join()` which performs literal string replacement.

### VERIFIED: Whitelist enforcement after DM/thread skip
**Files:** `discord.ts`, `telegram.ts`, `slack.ts`
**Status:** PASS — In all three adapters, whitelist checks run AFTER the mention skip logic but BEFORE message dispatch. The whitelist is never bypassed by auto-reply.

### VERIFIED: /help information disclosure
**File:** `src/core/router.ts` (handleHelp)
**Status:** PASS — Help output only contains AI alias names (e.g. "claude-code", "gemini"). No tokens, paths, environment variables, or internal state is exposed.

### VERIFIED: Reaction error isolation
**File:** `src/core/router.ts` (handleMessage)
**Status:** PASS — All `react`/`unreact` calls are wrapped in `.catch(() => {})`, ensuring reaction API failures (permission denied, rate limit, deleted message) never block the main message flow.

### VERIFIED: Discord DM intent
**File:** `src/adapters/im/discord.ts`
**Status:** PASS — `GatewayIntentBits.DirectMessages` added to receive DM events. Without this intent, Discord would silently drop DM MessageCreate events.

### NOTE: Discord `isDMBased()` vs `!guildId`
**File:** `src/adapters/im/discord.ts`
**Analysis:** We use `!message.guildId` to detect DMs. In discord.js v14, `channel.isDMBased()` is the canonical check, but `!guildId` is equivalent and available directly on the message without a channel type check. Both are correct; `!guildId` is slightly more direct.

### NOTE: Telegram reactions capability
**File:** `src/adapters/im/telegram.ts`
**Status:** `capabilities.reactions = false` remains unchanged. Telegram Bot API supports `setMessageReaction` but only for specific emoji sets and with restrictions. Intentionally not implemented.

## Test Coverage

| Feature | Tests | Status |
|---------|-------|--------|
| parseCommand | 5 | PASS |
| /help command | 2 | PASS |
| Reaction feedback (success) | 1 | PASS |
| Reaction feedback (error) | 1 | PASS |
| Reaction feedback (no react methods) | 1 | PASS |
| Auto-reply DM context | 1 | PASS |

## Files Changed

| File | Change |
|------|--------|
| `src/core/types.ts` | Added `react?` and `unreact?` to IMAdapter |
| `src/core/router.ts` | /help handler, reaction feedback, processMessage returns boolean |
| `src/adapters/im/discord.ts` | Auto-reply logic, react/unreact, DirectMessages intent |
| `src/adapters/im/telegram.ts` | Group mention check, auto-reply config, mention stripping fix |
| `src/adapters/im/slack.ts` | Thread auto-reply, react/unreact, duplicate event fix, emoji map |
| `src/utils/command.ts` | New — parseCommand utility |
| `src/index.ts` | AUTO_REPLY_IN_DM/THREADS env vars, passed to adapters |
| `tests/features.test.ts` | New — 11 tests for all 3 features |
| `.env.example` | Added AUTO_REPLY_IN_DM, AUTO_REPLY_IN_THREADS |
| `README.md` | Added DM/Thread, Commands, Reaction sections + env vars |
| `package.json` | Added features.test.ts to test command |
