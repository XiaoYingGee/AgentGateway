# Review R1 — Multimodal Attachments

**Reviewer:** Independent reviewer (read-only)
**Scope:** commits `63ec26a..cac361c` — InboundAttachment type, download utility, router integration, Discord/Telegram adapter parsing, tests, docs.
**Build/Test status:** `npm test` → **95/95 green** at HEAD. No regressions detected.

---

## Verdict: **REJECTED**

Three blocker-class issues:

1. **SSRF wide open** — adapters hand router an attacker-controlled URL and `downloadAttachment` blindly `fetch()`s it. From Discord/Telegram, an attacker can post a message whose attachment URL points at `http://169.254.169.254/...` or `http://127.0.0.1:<port>/...` and the gateway will dutifully fetch it, write the response to disk, and append the local path into an AI prompt that may be exfiltrated.
2. **Telegram bot token leaks into prompt + logs** — `buildFileUrl` returns `https://api.telegram.org/file/bot<TOKEN>/...`, which is then stored in `InboundAttachment.url`. The error path in `downloadAttachment` interpolates `att.url`-derived state into `AttachmentError` messages and the router logs the raw error; the attachment trailer also contains a path derived from a token-bearing URL. Beyond logs, a download failure is sent verbatim to the user (`❌ ${reason}`) — including any URL fragments grammy puts in fetch errors. Token rotation required if this ever shipped.
3. **MAX_ATTACHMENT_SIZE = 25 MB but Discord allows much larger uploads (and the 25 MB cap is only a floor against grossly oversized files, not a tight default).** Combined with the per-message 10× rate limit and zero per-session disk quota, a single allow-listed user (or a compromised IM account) can fill the disk with `25 MB × 10 / minute` indefinitely. There is **no GC** of `.attachments/<sessionId>/` anywhere in the codebase.

Plus a handful of correctness bugs (wrong return semantics on attachment failure, partial-failure resource leak, no path-traversal test that actually attempts traversal). Details below.

---

## Critical issues (must fix before merge)

- **[SSRF]** `src/utils/attachments.ts:115` — `fetchImpl(att.url, …)` performs no URL validation. Required: parse the URL, reject non-`http(s)`, and (unless explicitly opted in) reject hosts that resolve to private/link-local/loopback ranges. Suggested: `URL` parse → reject if hostname is `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `::1`, IPv6 link-local. For Telegram, only `api.telegram.org` should be allowed; for Discord, restrict to `cdn.discordapp.com` / `media.discordapp.net`. Without this, any allow-listed user can pivot the gateway into the host network.
- **[Token leak]** `src/adapters/im/telegram.ts:218` — `https://api.telegram.org/file/bot${token}/${file.file_path}` is stored in `InboundAttachment.url`, propagated into `downloadAttachment`, and surfaces in:
  - `AttachmentError` messages bubbled up through `router.ts:191-198` → user-visible `❌ ${reason}` (any wrapped fetch error from undici may include the URL).
  - `console.error` in `router.ts:147,251` (full stack with embedded URL on any failure path).
  - The attachment trailer printed to the AI prompt does not contain the URL today (only the local path), but `att.url` is still on the `InboundAttachment` that the router accepts and could leak via future logging.
  Fix: do not put the token in the URL stored on the message. Either (a) keep the bare `file_path` and resolve+download inside the Telegram adapter via a private helper, or (b) use a `headers`-style mechanism (the `Attachment.headers` field already exists for Slack) and rewrite `downloadAttachment` to accept a `urlBuilder` callback. Also: redact `att.url` before logging; sanitize before user-visible messages.
- **[Disk DoS / no GC]** `src/utils/attachments.ts:158-167` — files are written into `.attachments/<sessionId>/` and **never deleted**. The `Router` creates the directory on every download but nothing tracks lifetime. With 25 MB default cap, 10 msg/min rate limit, and stickiness, a single user can write 250 MB/min to disk. Required: per-session disk quota, TTL sweep tied to `SessionManager.destroy/sweep`, or delete after AI invocation completes. At minimum, implement a `.attachments/` sweep in the existing `[session] sweep` machinery (`session.ts` already cleans orphan session dirs).
- **[Wrong return semantics]** `src/core/router.ts:201` — when an attachment fails, `processMessage` returns `true` (= "handled"), which causes `handleMessage` at `:144-145` to react with **✅** even though the user got a `❌` message. `return false` is the correct value here so the reaction matches reality. Right now success and attachment-failure are visually indistinguishable in the reaction strip.
- **[Partial-failure resource leak]** `src/core/router.ts:181-189` — the `for` loop pushes successful downloads to `downloaded[]`. If the *third* of five attachments throws, the first two stay on disk and `downloaded[]` is GC'd without cleanup. Combined with the no-GC issue above this is a permanent leak. Required: in the `catch` block, `await unlink(d.path).catch(() => {})` for every entry already in `downloaded` before sending `❌`.

## Should fix

- **[Filename sanitizer misses Windows reserved + NUL]** `src/utils/attachments.ts:75-91` — the regex strips control chars (0x00 included) but does **not** check Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`). The project may currently target Linux only, but the docs claim "cross-platform" and contributors may run on macOS where some of these still cause issues with downstream tooling. Also: trailing dots/spaces are not stripped (Windows trims them, leaving filename collisions). Add: post-sanitize, if `basename` matches `/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i`, prefix with `_`. Strip trailing `.` and ` `.
- **[Empty filename after sanitize edge case]** `sanitizeFilename(":")` → `"_"`; `sanitizeFilename(".")` → falls through to `"file"`. Good. But `sanitizeFilename("\u202E")` (RTL override) and zero-width chars pass through. Lower priority but worth a single-line `replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "_")`.
- **[Header MIME bypass]** `src/utils/attachments.ts:140` — when the adapter advertises an allow-listed mime, the response `content-type` is **not re-checked** (`mimeType = att.mimeType ?? headerMime`). An attacker who controls the URL (Discord CDN can be tricked, or any future provider) can declare `image/png` in the IM payload while the actual response is `application/x-msdownload`. Suggested: always validate **both** `att.mimeType` and `headerMime` against the whitelist, requiring both to pass when both are present.
- **[Magic-byte / sniff missing]** Beyond MIME, no content sniffing happens. A `.png` claim with `MZ` header will sail through. For an AI gateway this is acceptable, but worth tracking — at minimum, refuse to write if the first chunk is `MZ` / `7F 45 4C 46` (PE/ELF) when MIME claims image/text/pdf.
- **[Telegram getFile race + timeout]** `src/adapters/im/telegram.ts:215` — `getFile` returns a URL with **no expiry guarantee**, and there's no per-request timeout on the subsequent `fetch`. Suggested: add `AbortController` with a 30s timeout in `downloadAttachment` (passed via `opts.timeoutMs`).
- **[Discord ephemeral URL no retry]** Discord attachment URLs now require signed query params and can expire. `downloadAttachment` does no retry on transient failure. Add a single retry with backoff for HTTP 5xx and `download` reason errors.
- **[Slack adapter not updated]** Slack adapter has no attachment parsing. README/CHANGELOG should call this out as "Discord + Telegram only" (CHANGELOG already does; please verify README's IM table marks Slack as 🚫 for attachments). The `Attachment.headers` field hints at Slack readiness but is unused.
- **[Race in `editChain` + attachment trailer]** `router.ts:226` — when streaming, `streamedText` does **not** include the attachment trailer; only the *final* edit/segment does. This means the user sees streaming output that, mid-flight, looks shorter than the final reply because the AI sometimes echoes attachment metadata. Cosmetic but worth documenting; alternatively pass `promptWithAttachments` to the streaming preview only when the AI's preamble would echo paths.
- **[Per-session attachment dir uses sanitized sessionId — collision risk]** `src/utils/attachments.ts:159-160` — `sanitizeFilename(sessionId)` collapses `/`, `:`, `.` to `_`, so `discord:guild:G:channel:C:user:U` and `discord_guild_G_channel_C_user_U` map to the **same directory**. With current session keys this is unlikely to collide, but it's a footgun. Use a stable hash (e.g. `crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 32)`) or base64url instead.
- **[`if (!this.rateLimits.has(userKey)) this.rateLimits.set(userKey, timestamps);` is dead]** `router.ts:113` — the previous block already calls `this.rateLimits.set(userKey, timestamps)` when initializing. The `if` is unreachable after `timestamps.push(now)`. Drop it. (Pre-existing; surfaced by reading the diff context.)
- **[`written === 0` fallback uses `stat`]** `attachments.ts:201-208` — if the streamed body is genuinely empty (`written === 0`), the code stats the file and reports the on-disk size. Why? An empty download is almost certainly an error. Suggested: throw `AttachmentError("empty body", "download")` instead of silently storing a 0-byte file.

## Nice to have

- Hoist `await import("node:stream")` (`attachments.ts:172`) to a top-level static import — the dynamic import per call is wasteful and obscures cold-path failures.
- Replace `Number(largest.file_size)` chains in `telegram.ts` with a `safeNumber` helper to avoid duplication.
- `formatBytes(0)` → `"0B"`; `formatBytes(1024 * 1024)` → `"1.00MB"` but `2048` → `"2.0KB"`. Pick one decimal precision and stick with it.
- `formatAttachmentTrailer` outputs absolute paths into the AI prompt. For Codex/Claude harnesses this is fine; for prompts logged elsewhere consider using `path.relative(cwd, p)` to reduce log noise.
- `DownloadedAttachment` and `Attachment` differ by one field (`path`). Consider renaming `Attachment` → `AttachmentSpec` for clarity.
- `MAX_BOT_CHAIN = 3` and `consecutiveBots` count in `discord.ts:174-184` runs an API fetch *after* whitelist passes — fine, but the `messages.fetch({ limit })` happens for every message and is expensive. Out of scope for this review.
- Default `MAX_ATTACHMENT_SIZE` of 25 MB is reasonable; document it in README.
- Consider parallel downloads with `Promise.allSettled` once partial-failure cleanup is implemented — current serial loop is conservative but slow for users sending 5 photos.

## Test gaps

- **No path-traversal attack test.** `tests/attachments.test.ts:228` only asserts that a `../../evil.png` filename is sanitized, but does **not** verify that the resolved write path stays under `baseDir`. Add an assertion: `assert.ok(path.relative(baseDir, result.path).indexOf("..") !== 0)`.
- **No NUL byte / unicode filename test.** Add: `sanitizeFilename("a\x00b.png")` → no NUL; `sanitizeFilename("文件.png")` → preserved (non-ASCII should *not* be lost — check the current regex isn't too aggressive).
- **No mid-stream truncation test.** All `makeFetch` test bodies enqueue a single chunk and close cleanly. Add a test where `ReadableStream` errors mid-stream: assert that the partial file is removed (currently it isn't — see partial-failure issue).
- **No partial multi-attachment failure test.** All router tests use one attachment. Add: 3 attachments, second one fails MIME → assert AI not invoked, `❌` sent, **and** first download cleaned up.
- **No SSRF guard test.** Add (and implement): downloading from `http://127.0.0.1/foo` rejects with reason `"download"` or new `"network-policy"`.
- **No content-length=0 test.** Currently silently stored.
- **No test that `❌` failure path returns `false` from `processMessage`.** This would have caught the wrong reaction-strip behavior.
- **No timeout test.** Add a fake fetch that never resolves; assert `downloadAttachment` times out within an expected window.
- **No Telegram adapter unit test for token leakage.** Mock `getFile` and assert the token never appears in the constructed `InboundAttachment` after fix.

## Praise (做对的事)

- **Streaming size guard via `Transform`** is the correct pattern — fail-fast without buffering, and returns `AttachmentError` with a clean reason. Nicely done at `attachments.ts:170-184`.
- **Fail-closed MIME whitelist** — empty/undefined → reject. The tests at `attachments.test.ts:91-94` lock this in. ✅
- **`AttachmentError.reason` enum** (`size | mime | download | io`) gives the router a clean way to attribute failures; this will pay off when adding observability.
- **Path containment double-check** at `attachments.ts:165-167` (`if (!target.startsWith(dir + path.sep))`) is good defense in depth even though `sanitizeFilename` should already prevent escape.
- **Pre-flight size/mime check** before opening a connection avoids wasted fetches when adapter metadata is trustworthy.
- **Telegram photo selection picks the largest size** (`msg.photo[msg.photo.length - 1]`) — correct interpretation of the PhotoSize array.
- **Rate-limit map cleanup (P2)** in router is properly handled; tests cover it.
- **Documentation discipline:** CHANGELOG and README updated in the same series — easy to audit. The IM capability table is the right shape; just make sure Slack is explicitly marked unsupported.
- **Tests pass 95/95 with new coverage.** Coverage of the *positive* paths and most security-relevant rejections is solid; gaps above are about adversarial cases, not basic functionality.

---

## Required follow-ups before re-review (R2)

1. SSRF guard with tests.
2. Telegram token isolation (no token in `InboundAttachment.url`, no token in user-visible errors or logs).
3. Disk GC (TTL sweep or post-invocation cleanup).
4. Partial-failure cleanup in router.
5. Fix `processMessage` return value on attachment failure.
6. Path-traversal assertion in tests.

Once these land I'll re-run the checklist. Everything in "Should fix" can wait for R3 if scope is tight.
