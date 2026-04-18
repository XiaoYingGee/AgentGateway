# FIX-R3 — Coder log: post-R2-review + post-QA-R2 hardening

Scope: address the 1 HIGH (+ 4 LOW/MED) findings from `REVIEW-R2.md` and the
2 HIGH SSRF bypasses + GC active-session bug + 2 semantic issues from
`QA-R2.md`. Magic-byte sniffing and Discord 5xx retry are explicitly deferred
(both flagged `[DEFERRED]` in the QA-R2 test suite, agreed with reviewer).

Build/test status after R3: `npm run build` ✅ · `npm test` ✅ · **265 / 265
passing** (was 243 / 243 going in; net +22).

| # | Severity | Issue | Where | Commit | Tests |
|---|----------|-------|-------|--------|-------|
| 1 | 🔴 P0 | SSRF Bypass A — fetch follows redirects to internal hosts | `src/utils/attachments.ts` `downloadAttachment` | `5cd23ba` | `tests/qa-r2-attachments.test.ts` `QA-R2 P0-1 SSRF: redirect-to-internal` (flipped); `tests/r3-fixes.test.ts` `R3 #1 SSRF redirect handling` (3 cases incl. hop-cap) |
| 2 | 🔴 P0 | SSRF Bypass B — IPv4-mapped IPv6 hex form bypasses `isPrivateIp` | `src/utils/attachments.ts` `isPrivateIp` | `8e10ea0` | `QA-R2 P0-1 SSRF: IPv4-mapped IPv6 in URL hostnames` (6 flipped) + `R3 #2 IPv4-mapped IPv6 classification` (8 cases incl. CGN, public-v6 control) |
| 3 | 🔴 P0 | GC sweep removes files of active sessions | `src/utils/attachments-gc.ts` + `src/core/router.ts` | `edf2bc2` | `R3 #3 GC active-session awareness` (2 cases) + `QA-R2 P1-7 GC: active-session awareness` rewritten to assert SKIP |
| 4 | 🔴 P0 | Empty-body guard misfires when CL header absent (NR-1) | `src/utils/attachments.ts` headerLen parse | `d611a1b` | `QA-R2 new-hunt: response.body empty edge` (flipped) + `R3 #4 Empty-body guard` (3 cases: missing/explicit-0/non-empty) |
| 5 | 🟡 P1 | DNS rebinding TOCTOU between guard and fetch | `src/utils/attachments.ts` `assertSafeUrl` returns IPs; redirect loop re-validates each hop | `5cd23ba` | Covered indirectly by R3 #1 redirect tests; trade-off documented in commit |
| 6 | 🟡 P1 | AI invoke failure leaves `downloaded[]` for 24h GC | `src/core/router.ts` `processMessage` finally | `c237e9c` | `R3 #6 Router unlinks downloads when AI invocation throws` |
| 7 | 🟡 P1 | Telegram `filePath` interpolated raw — defense-in-depth hygiene | `src/utils/attachments.ts` `resolveTelegramFileUrl` | `b1ebc1b` | `R3 #7 Telegram filePath encoding` (spaces + unicode) |
| 8 | 🟡 P1 | CL-mismatch surfaces as `reason:"io"` (was supposed to be `download`) | `src/utils/attachments.ts` `AttachmentError` reason union + pipeline catch | `cc5122d` | `R3 #8 Content-Length truncation reports reason='download_truncated'`; `QA-R2 P0-3` assertion updated to allow the new reason |

(QA-R2 baseline import + double-blind reports landed earlier as `9ae622e`.)

## Design notes / trade-offs

### #1 Redirect handling
- `MAX_REDIRECT_HOPS = 3`. Discord/Slack CDNs typically use ≤ 1 redirect; 3
  gives slack for chained CDN/origin without being weaponizable as a long
  pipe. Loops surface as `AttachmentError(reason: "redirect_loop")` — a new
  reason in the union so callers can branch if they ever want to retry.
- `Location` is resolved via `new URL(loc, currentUrl)` so both absolute and
  relative redirects behave correctly.
- On every hop we re-run `assertSafeUrl`, even on the first one. We drain the
  3xx body via `res.body?.cancel()` so the TCP connection can be reused.

### #2 IPv4-mapped IPv6
- Two regexes cover the WHATWG-normalised forms:
  - dotted: `::ffff:N.N.N.N` and the fully-expanded `0:0:0:0:0:ffff:N.N.N.N`
  - hex tail: `::ffff:HHHH:HHHH` and `0:0:0:0:0:ffff:HHHH:HHHH`
- Hex tail is decoded back to dotted v4 and the function recurses, so the
  existing v4 private/loopback table is the single source of truth.
- Malformed `::ffff:` mapped forms fail closed (return `true` → treated as
  private).

### #3 GC active-session
- Approach: pass an `activeSessionDirs: Set<string>` (sha256-hashed dir name)
  into `sweepAttachments` and skip those dirs entirely.
- `Router.handleMessage` adds the session-dir hash to the set before
  attachment downloads start and removes it in the `finally` block. The
  `startAttachmentGc` API gained a `getActiveSessionDirs?: () => Set<string>`
  callback so it pulls the live set on every tick (no stale snapshots).
- Chose this over the "touch mtime on every read" approach because (a) it's
  simpler, (b) it works even when the AI doesn't reopen a file, and (c) it
  doesn't require any code in the AI tool path.

### #4 Empty-body
- Root cause was `Number("") === 0`. Fixed by reading the header with
  `res.headers.get("content-length")` (returns `null` when absent), then
  `null → NaN, present → Number(...)`. The downstream guards already used
  `Number.isFinite`, so a `NaN` correctly skips the size guard and falls
  through to the empty-body reject.

### #5 DNS rebinding (TOCTOU)
- Accepted simplification: `assertSafeUrl` runs per redirect hop and now
  *returns* the resolved IP list, but we still let `fetch` perform its own
  DNS lookup. Pinning to the validated IP would require a custom `Agent`
  (undici dispatcher) or rewriting URLs to use the IP literal with a
  `Host` header override — both have ergonomic / TLS-SNI complications.
- The residual rebind window is sub-second and requires (a) a public-then-
  private flip of the same hostname between two consecutive lookups and
  (b) the gateway being deployed in a network where private IPs lead
  somewhere interesting. For the current threat model (operator-controlled
  Discord/Telegram users on a hardened VM with no metadata service exposed
  to the gateway), this is acceptable. Tracked for future hardening.

### #6 Router cleanup on AI failure
- Hoisted `downloaded`, `aiInvokeFailed`, and `sessionDirKey` to the outer
  `try` scope so the `finally` block can clean up regardless of where the
  throw came from. The cleanup only fires when `aiInvokeFailed` is true so
  we don't double-unlink files the attachment-download failure path already
  removed.

### #7 Telegram filePath encoding
- Used `encodeURI`, **not** `encodeURIComponent`, because Telegram's
  `file_path` legitimately contains `/` between subdirectory segments
  (e.g. `documents/foo.pdf`). `encodeURI` preserves URL structural
  characters and only encodes spaces, control chars, and non-ASCII bytes.

### #8 CL-mismatch reason
- Added `download_truncated` to the `AttachmentError.reason` union (next to
  `redirect_loop`). Both the post-stream `written !== headerLen` check and
  the pipeline `catch` now produce this reason when the transport
  terminates early with a declared CL > 0. The pipeline catch also keeps a
  fallback to `io` for genuine write-side failures.

## Files touched

- `src/utils/attachments.ts` — error reasons, IPv4-mapped IPv6, redirect-aware
  download loop, headerLen parse, encoded Telegram filePath, truncation reason.
- `src/utils/attachments-gc.ts` — `activeSessionDirs` parameter on
  `sweepAttachments` + `getActiveSessionDirs` callback on `startAttachmentGc`.
- `src/core/router.ts` — `activeSessionDirs` set, hoisted `downloaded`/
  `aiInvokeFailed`, AI-failure unlink, GC wiring.
- `tests/qa-r2-attachments.test.ts` — flipped 6 BROKEN tests + added active-skip
  test; updated CL-mismatch reason allow-list.
- `tests/r3-fixes.test.ts` — new file, 16 cases mapped 1:1 to the 8 fixes.
- `package.json` — test script includes `tests/r3-fixes.test.ts`.
- `CHANGELOG.md` — R3 section under Unreleased.
