# Review R2 — Multimodal Attachments (post-fix)

**Reviewer:** Independent reviewer R2 (read-only, fresh eyes — does **not** trust FIX-R2 self-report).
**Scope:** commits `cac361c..9319161` (7 new commits).
**Build/test:** `npm run build` ✅ · `npm test` ✅ · **208 / 208 passing**.

---

## Verdict: **APPROVED_WITH_FIXES**

The R1 critical-class issues are materially closed: SSRF guard exists with a real
truth-table, the Telegram bot token no longer enters `InboundAttachment.url`,
GC sweeps `.attachments/` on a timer, the router cleans up partial multi-attachment
batches, queued attachments survive the drain loop, and `processMessage` finally
returns `false` on attachment failure so the reaction matches reality.

But the SSRF guard has **one important hole** that R1 already hinted at and that
QA explicitly recommended: `assertSafeUrl` runs **before** the fetch, but the
fetch itself follows redirects with no re-validation. A public CDN URL that
30x-redirects to `127.0.0.1` (or AWS metadata) still works. That alone keeps me
from voting full APPROVED — it must be fixed before the gateway is exposed to
URLs that any external party can choose.

Everything else is either green or a deferred-with-cause item I agree with.

---

## R1 closure status (each item independently verified at file:line)

### 5 critical (Reviewer R1)

- **R1-Crit-1 SSRF guard** — `src/utils/attachments.ts:215-262` (`assertSafeUrl`),
  invoked at `:309` from `downloadAttachment`. Protocol whitelist, IP-literal
  reject, DNS resolve + per-address `isPrivateIp` check, env override.
  **CLOSED ✅** for the direct-URL case.
  **NOT_CLOSED ❌** for the redirect case — see "New issues #1" below.
  IPv6-mapped-IPv4 (`::ffff:127.0.0.1`) is correctly recursed at `:155-156`. CIDR
  boundaries (`172.15`/`172.16`/`172.31`/`172.32`, `100.64`/`100.128`) are
  asserted in `tests/ssrf.test.ts:26-37`. ✅

- **R1-Crit-2 Telegram token leak** —
  `src/adapters/im/telegram.ts:218,222-223` `buildFileUrl` returns
  `tg-file://<file_id>` (sync, no token). Resolver lives at
  `src/utils/attachments.ts:172-213` and reads the token from
  `TELEGRAM_BOT_TOKEN` env at fetch time. Errors flow through `redactToken()`
  (`:163-167`). Logging audit: `router.ts` only logs the `Error` object,
  `redactToken` covers the `bot<digits>:<secret>` and `?token=` patterns.
  **CLOSED ✅** (with one tiny note: `filePath` returned from Telegram's
  `getFile` is interpolated raw at `:209` — Telegram itself is trusted, but if
  api.telegram.org ever returned a `..`-bearing path the URL would be malformed;
  not an exploit, just a hygiene note.)

- **R1-Crit-3 Disk DoS / no GC** —
  `src/utils/attachments-gc.ts` provides `sweepAttachments` (file age + empty-dir
  cleanup) and `startAttachmentGc` (initial sweep + interval, `unref`'d).
  Wired into `Router.start/stop` at `src/core/router.ts:386,408`. Configurable
  via `ATTACHMENT_TTL_HOURS`; `0` disables; default 24h. Sweep walks two
  directory levels only (`.attachments/<session>/<file>`); session names are
  sha256-hex (`hashSessionId`) so path-traversal is impossible by construction.
  **CLOSED ✅**, with one observation: downloads are **never** explicitly
  unlinked after a *successful* AI turn — they only disappear on the 24h sweep.
  This is intentional (lets AI tool-calls re-open the file across follow-ups)
  but means worst-case disk usage is `users × 25 MB × 10/min × 24 h`. Document
  the budget if not already.

- **R1-Crit-4 `processMessage` returns wrong value on attachment failure** —
  `src/core/router.ts:225` now `return false`, asserted in
  `tests/router-attachments.test.ts:54-78` (the test injects a 500 server,
  reads `im.reactions`, asserts `❌` is there and `✅` is **not**).
  **CLOSED ✅**.

- **R1-Crit-5 Partial-failure resource leak** —
  `src/core/router.ts:212-216` (`Promise.all(downloaded.map(d => unlink…))`),
  asserted in `tests/router-attachments.test.ts:81-126` by walking
  `.attachments/` and counting `.png` survivors after a 2-attachment failure.
  Cleanup also runs in the `pipeline` `catch` at `src/utils/attachments.ts:336`.
  **CLOSED ✅**.

### 11 should-fix (Reviewer R1)

| # | Item | Status | Where verified |
|---|---|---|---|
| 1 | Filename sanitizer — Windows-reserved + trailing dots/spaces | **CLOSED ✅** | `src/utils/attachments.ts:32,87,90` (`WINDOWS_RESERVED`, trailing `[. ]+` strip) |
| 2 | Zero-width / RTL override / BOM strip | **CLOSED ✅** | `src/utils/attachments.ts:84` (`\u200B-\u200F\u202A-\u202E\uFEFF`) |
| 3 | Header MIME re-validation (response Content-Type) | **CLOSED ✅** | `src/utils/attachments.ts:286-293` (`isMimeAllowed(headerMime, …)` check) — flipped QA-5.2 test asserts |
| 4 | Telegram getFile timeout | **CLOSED ✅** | `src/utils/attachments.ts:185-186` (5s `AbortController`) |
| 5 | Per-request download timeout | **CLOSED ✅** | `src/utils/attachments.ts:268,271` (`ATTACHMENT_TIMEOUT_MS`, default 30s) |
| 6 | Per-session dir collision (sanitize → sha256) | **CLOSED ✅** | `src/utils/attachments.ts:108-110` (`hashSessionId`) used at `:317` |
| 7 | "Dead `if (!this.rateLimits.has)`" — Coder disputes | **CODER CORRECT** — see "Coder's dispute" below |
| 8 | Empty-body `written === 0` should be an error | **CLOSED ✅** | `src/utils/attachments.ts:362-368` (throws unless server explicitly said `Content-Length: 0`) |
| 9 | Hoist `await import("node:stream")` to top-level | **CLOSED ✅** | `src/utils/attachments.ts:3` static `import { Readable, Transform } from "node:stream"` |
| 10 | Magic-byte / PE-ELF sniff | **NOT IMPLEMENTED — DEFERRED** (R1 marked nice-to-have) — agree |
| 11 | Discord ephemeral-URL retry on 5xx | **NOT IMPLEMENTED — DEFERRED** — agree |
| 12 | editChain attachment-trailer streaming cosmetics | **NOT IMPLEMENTED — DEFERRED** (cosmetic) — agree |

(Items 10–12 are the three R1 "should-fix" entries that FIX-R2 also called
deferred. R1 explicitly tagged 10/12 as nice-to-have / "worth tracking", so
deferral is reasonable. 11 is a real should-fix but is a cross-cutting retry
helper; deferring is acceptable provided it's tracked as a follow-up.)

### 3 QA-only critical findings (QA-R1, beyond R1)

| ID | Status | Where verified |
|---|---|---|
| QA-3.3 lying Content-Length truncation | **CLOSED ✅** | `src/utils/attachments.ts:351-358` (assert `written === headerLen` when declared, unlink + throw); flipped test at `tests/qa-attachments.test.ts:224-247` |
| QA-5.2 server-MIME laundering | **CLOSED ✅** | (item #3 above) |
| QA-7.2 queued-message attachments dropped | **CLOSED ✅** | `src/core/session.ts:119-141,147-174` (snapshot at enqueue, union in drain); `src/core/router.ts:303-314` (drain loop builds synthetic msg with `queued.attachments`); test `tests/router-attachments.test.ts:128-200` |

---

## New issues introduced (or left open) by R2 fixes

1. **`src/utils/attachments.ts:312` — SSRF guard does not survive HTTP redirects.** *Severity: HIGH* (security).
   `assertSafeUrl(effectiveUrl)` runs once on the original URL. The subsequent
   `fetchImpl(effectiveUrl, …)` (line `:325`) uses the default `redirect: "follow"`,
   so a public URL that 302s to `http://127.0.0.1/` (or `169.254.169.254`) is
   followed transparently with no re-check. R1's "SSRF" finding and QA's P0 #1
   bullet *both* called this out (QA-R1 P0 #1: *"Pass `redirect: 'manual'` to fetch,
   follow yourself, re-validate each hop."*) and this is the one piece that
   didn't land. Required fix: pass `redirect: "manual"` and either reject 3xx
   outright or re-run `assertSafeUrl` against the `Location` header (and decrement
   a hop counter so we don't loop). Add a regression test that serves a 302 →
   `http://127.0.0.1` from a public-looking origin and asserts rejection.

2. **`src/utils/attachments.ts:243-262` — DNS rebinding TOCTOU.** *Severity: LOW–MEDIUM*
   (real but very hard to exploit against this target).
   `assertSafeUrl` calls `dns.lookup`, then `fetchImpl` performs its own
   independent resolution. An attacker who controls a DNS server with a
   sub-second TTL can return a public IP for the guard's lookup and a private
   IP for fetch's lookup. Mitigations are non-trivial without changing the
   transport (pin to the resolved address, use an `Agent` with custom `lookup`,
   or perform the DNS resolution yourself and pass the IP into the URL with a
   `Host` header override). Suggest documenting the residual risk + adding a
   cheap mitigation: when the host is non-IP, prefer `https:` and rely on the
   TLS SNI + cert host check to make the public→private flip much harder.

3. **`src/core/router.ts:198-282` — outer catch does not unlink successful downloads when AI invocation fails.** *Severity: LOW.*
   The `try` covers the AI invoke + send. If `aiAdapter.invoke` throws (timeout,
   resume failure, anything), `downloaded[]` files are abandoned for the GC sweep
   to handle — up to 24 h on disk. Worth either (a) wrapping the AI invoke in
   its own try and unlinking on failure or (b) explicitly noting the design
   ("downloaded files outlive the turn so the AI can reopen them; periodic GC
   reclaims them"). Today FIX-R2's docs say only the partial-batch path cleans up.

4. **`src/utils/attachments.ts:209` — `filePath` from Telegram is interpolated raw.** *Severity: LOW (defense in depth).*
   `https://api.telegram.org/file/bot${token}/${filePath}`. Telegram is trusted,
   but a stray `..` or scheme switch in `filePath` would produce a malformed URL
   that the post-resolve `assertSafeUrl(effectiveUrl)` would still catch on the
   private-IP rule, so this is informational rather than exploitable. Consider
   `encodeURI(filePath)` for hygiene.

5. **`src/utils/attachments-gc.ts:46-51` — sweep races with in-flight downloads in the unlikely case TTL ≤ download wall-clock.** *Severity: NEGLIGIBLE.*
   With default TTL = 24 h and a 30-second download cap, this won't happen in
   practice. Documented for completeness.

No new issues found in: filename sanitizer (NUL/`<>:"|?*`/zero-width all
covered), session-id hashing (sha256 prefix is collision-free for the input
space), Content-Length integrity (boundary cases reasoned through below),
random suffix collision, header-MIME re-check.

### Boundary-case audit for Content-Length check (`attachments.ts:351-368`)

| Case | Behaviour | Verdict |
|---|---|---|
| CL declared and matches body | `headerLen > 0 && written === headerLen` → no throw | ✅ |
| CL declared > delivered (truncation) | mismatch → unlink + `download` throw | ✅ |
| CL=0, body empty | `headerLen > 0` is false; `written===0 && headerLen===0` allows it | ✅ matches QA-3.5 |
| CL=0, body non-empty | undici stops reading at 0, body silently empty → caught by `written===0` arm if no `headerLen===0` (but here `headerLen===0` is set, so it would be allowed). **Edge.** Highly unusual server behaviour; not a security issue but worth a one-line check `if (headerLen===0 && written>0) throw`. *Severity: NEGLIGIBLE.* |
| No CL header, body present | `headerLen` is `Number("") = 0` → `headerLen > 0` false → length check skipped, streaming guard still policed | ✅ |
| No CL header, empty body | `written===0`, `headerLen===0` allows — but no CL was actually declared. Currently treated as legitimate empty (allowed). Per Reviewer feedback this should reject. **Minor:** the code uses `Number.isFinite(headerLen) && headerLen===0` which is true for `""`/missing because `Number("")===0`. So a missing-CL empty body is *also* silently allowed. Fix: distinguish "header absent" from "header == 0", e.g. read `res.headers.get("content-length")` once and branch on null vs. number. *Severity: LOW.* |

The empty-body rejection added at `:362-368` is partly defeated by `Number("")
=== 0` making `headerLen === 0` true even when the header is absent. Worth
tightening before re-review.

---

## Coder's dispute on R1 should-fix #7 (dead `if (!this.rateLimits.has)`)

**Coder is correct. R1 reviewer was wrong.** Verified by reading
`src/core/router.ts:97-114`:

```ts
let timestamps = this.rateLimits.get(userKey);
if (!timestamps) { timestamps = []; this.rateLimits.set(userKey, timestamps); }
while (timestamps.length > 0 && timestamps[0]! <= now - RATE_LIMIT_WINDOW_MS) timestamps.shift();
if (timestamps.length === 0) this.rateLimits.delete(userKey);   // ← P2 cleanup
if (timestamps.length >= RATE_LIMIT_MAX) { …; return; }
timestamps.push(now);                                            // ← length now 1, but Map entry was deleted above
if (!this.rateLimits.has(userKey)) this.rateLimits.set(userKey, timestamps);  // ← REQUIRED to re-attach
```

Without the re-attach, the next message from the same user would `Map.get → undefined`,
spawn a fresh array, and lose the just-pushed timestamp. The line is functional, not dead.
The R1 reviewer (me, in a prior life) missed the `delete` two lines above. **Arbitrated: keep the line.**

---

## Deferred items review

| Deferred item | R2 reasoning | My take |
|---|---|---|
| Magic-byte sniffing (PE/ELF reject) | "out of scope; not a virus scanner" | **Agree.** R1 already marked nice-to-have. |
| Discord ephemeral-URL retry on 5xx | "needs a separate retry helper" | **Agree to defer**, but track as a follow-up — Discord URLs do flake and the user-visible failure mode is the entire turn dying to a transient 5xx. |
| editChain attachment-trailer streaming cosmetic | "cosmetic, R1 said 'worth documenting'" | **Agree.** |
| Slack adapter attachment parsing | "out of scope, CHANGELOG marks unsupported" | **Agree** as long as README's IM table also says so (didn't re-check this round; R1 asked for it). |
| Parallel `Promise.allSettled` downloads | "conservative serial download is intentional" | **Agree** until production traffic demands otherwise. |
| `MAX_BOT_CHAIN` API-fetch hot path | R1 marked out-of-scope | **Agree.** |
| CDN allow-list (cdn.discordapp.com etc.) on top of SSRF guard | "open as follow-up" | **Lean disagree** — once #1 above (redirect bypass) is fixed, an additional adapter-side allow-list is mostly hygiene. Deferral is OK. |

---

## New-test quality review

50 SSRF tests + 5 token isolation + 3 router-semantics + 10 GC = **68 net new
cases**, plus the 3 flipped QA cases (3.3/4.5/4.6/5.2/7.2 — Coder counts 5
flipped; same set).

- **`tests/ssrf.test.ts`** — Truth-table style, tests `isPrivateIp` directly
  with no mocks (real verification, not theatre). Integration tests use
  `enforceUrlValidation: true` to bypass the test-only `!!opts.fetchImpl`
  auto-skip — correct discipline. **Real coverage.** Missing: a redirect-bypass
  test (would catch finding #1) and a DNS-rebinding test (would catch finding
  #2). The IPv4-mapped-IPv6 case is only one entry (`::ffff:127.0.0.1`); fine.
- **`tests/telegram-token.test.ts`** — Asserts placeholder URL has no token,
  resolver fails closed when env missing, end-to-end download via mock,
  error-message redaction. **Genuine.**
- **`tests/router-attachments.test.ts`** — Uses a real `http.createServer`
  (not just mocked `fetchImpl`) so the failure-cleanup test actually exercises
  the file-system. The QA-7.2 test holds the first AI invocation open via a
  promise so messages 1+2 actually enqueue — the timing is real.
  **High-confidence test.**
- **`tests/attachments-gc.test.ts`** — Uses `utimesSync` to age files to the
  past — real filesystem assertions, no mocks. Empty-dir cleanup, env override,
  TTL=0 disabling, `startAttachmentGc` initial sweep. **Genuine.**
- **`tests/qa-attachments.test.ts` flipped cases** — All asserting the *fixed*
  behaviour now (no `t.skip`, no `KNOWN GAP`-as-expected). Verified by greps.

No tests are mock-stubbed to the point of being useless. The auto-skip of
`assertSafeUrl` when a custom `fetchImpl` is supplied (`attachments.ts:299-301`)
is by design and covered by `enforceUrlValidation` in the SSRF tests.

---

## Final go/no-go for production

**Conditional GO.** Block on one item before opening the gateway to URLs supplied
by untrusted senders:

- **Must-fix #1:** Add redirect-aware SSRF (manual redirect + per-hop
  `assertSafeUrl`) and a regression test. *Estimated effort: ~30 lines, one
  test.* This is the only finding I would block production for.

Strongly suggested before the next deploy:

- Tighten the empty-body branch so missing `Content-Length` does not look like
  `Content-Length: 0` (table row above).
- Wrap AI-invoke failure to also unlink `downloaded[]`, or document the GC
  reliance.

Acceptable to ship as-is for any environment where the only attachment senders
are trusted operators (i.e. the current allow-listed Discord/Telegram users) and
the gateway is **not** deployed on a cloud VM where 169.254.169.254 metadata
exposure matters. Once finding #1 is fixed I'd switch this to **APPROVED** with
no further conditions.

---

**Production-ready?** Not quite — fix the redirect bypass first. Everything
else from R1/QA-R1 is genuinely closed.
