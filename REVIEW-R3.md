# Review R3 — Final attachments hardening

**Reviewer:** Independent reviewer R3 (read-only, fresh eyes — does not trust
FIX-R3 self-report).
**Scope:** commits `cac361c..0b4f8a9` (8 new commits since R2 sign-off).
**Build/test:** `npm run build` ✅ · `npm test` ✅ · **265 / 265 passing**.

---

## Verdict: **APPROVED**

Every blocking item from `REVIEW-R2.md` ("New issues #1–#3 + boundary-case empty-
body row") and from `QA-R2.md` ("MUST FIX before exposing to untrusted senders"
+ both SHOULD FIX items) is genuinely closed at the file:line level. The 16
new R3 regression tests are real (real `http.createServer` + real socket
truncation + `utimesSync` ageing — no mock theatre), and they all assert the
*fixed* behaviour (no `t.skip`, no "broken" pinning). The remaining items in
`tests/qa-r2-attachments.test.ts` that still pin broken behaviour are the
agreed-on `[DEFERRED]` set (magic-byte sniffing, Discord 5xx retry) — the same
deferrals R2 explicitly approved.

This is the first round where the SSRF guard is actually airtight against the
attack surface the gateway exposes (URL-supplied attachments from any external
sender), and the disposable-file hygiene story is consistent across all three
failure paths (attachment-download, AI-invoke, idle-GC).

---

## R2 closure status (per item)

### From `REVIEW-R2.md` — "New issues introduced (or left open)"

- **R2-1 SSRF redirect bypass — CLOSED ✅**
  `src/utils/attachments.ts:295` sets `redirect: "manual"` on every fetch.
  `:309-336` is a per-hop loop that:
  - reads `Location` (rejects 3xx without it),
  - resolves it relative to `currentUrl` via `new URL(loc, currentUrl)` so
    absolute and relative redirects both work,
  - increments a hop counter and throws `AttachmentError(reason:"redirect_loop")`
    when it exceeds `MAX_REDIRECT_HOPS = 3` (file `:46`),
  - re-runs `assertSafeUrl(nextUrl)` on every follow (skipped only when the
    test path is using a custom `fetchImpl` without `enforceUrlValidation`),
  - drains the 3xx body with `res.body?.cancel()` so the TCP connection can be
    reused.
  Tests: `tests/r3-fixes.test.ts` "R3 #1 SSRF redirect handling" — three cases:
  (a) public-looking 302 → loopback IP literal **rejected**, with an explicit
  `assert.strictEqual(internalReached, false)` that proves the internal handler
  was never called; (b) self-referential redirect loop hits the hop cap and
  throws `redirect_loop`; (c) control case where 302 → same-origin /dest
  succeeds end-to-end. The QA-R2 broken-pin test is also flipped now.

- **R2-2 DNS rebinding TOCTOU — CLOSED-with-trade-off ✅ (acceptable)**
  Per-hop `assertSafeUrl` runs again on the resolved Location, and
  `assertSafeUrl` now returns `{ addresses }` so callers could pin if they
  wanted to. The implementation deliberately does *not* pin to the validated
  IP via a custom undici `Agent`; the trade-off is documented in
  `attachments.ts:325-332` and `FIX-R3.md` §5. For the gateway's threat model
  (operator-controlled senders on a hardened VM with no metadata service
  reachable) this is the right call. Reviewer R2 explicitly graded this LOW–
  MEDIUM with "Mitigations are non-trivial without changing the transport" —
  the chosen mitigation matches that guidance.

- **R2-3 AI-failure leaves downloaded[] for GC — CLOSED ✅**
  `src/core/router.ts:191-197` hoists `downloaded`, `aiInvokeFailed`, and
  `sessionDirKey` to the outer scope. `:340-342` sets `aiInvokeFailed = true`
  in the catch. `:357-361` unlinks the files in finally **only** when
  `aiInvokeFailed` is true (so we don't double-unlink the attachment-download
  failure path which already cleaned up before returning false at `:226`).
  Test: "R3 #6 Router unlinks downloads when AI invocation throws" — uses a
  real `http.createServer` to deliver the attachment, an AI adapter that
  throws, then walks `<baseDir>/.attachments/` and asserts `pngs === 0`. ✅

- **R2-4 Telegram filePath interpolated raw — CLOSED ✅**
  `attachments.ts:218` returns `https://api.telegram.org/file/bot${token}/${encodeURI(filePath)}`.
  `encodeURI` (not `encodeURIComponent`) preserves `/` between subdirectory
  segments — verified by the test, which feeds `documents/中文 file name.pdf`
  and asserts the URL parses, the slash survives, no spaces remain, and
  unicode is percent-encoded. Reviewer R2 graded this LOW (defense-in-depth);
  the fix lands cleanly without breaking the legitimate `documents/...` path.

- **R2-5 GC race with in-flight downloads — N/A (NEGLIGIBLE per R2)**
  Same default-TTL math as R2; no regression. Reviewer R2 graded this
  NEGLIGIBLE; not in R3 scope.

- **R2 boundary-case empty-body row — CLOSED ✅** (this is QA-R2 NR-1)
  `attachments.ts:362-363` reads `res.headers.get("content-length")` once,
  branches on `null → NaN` vs `present → Number(...)`. The downstream guards
  use `Number.isFinite(headerLen)` so a NaN correctly falls through to the
  empty-body reject without conflating "header absent" with "header == 0".
  Tests: "R3 #4 Empty-body guard distinguishes missing CL from CL: 0" — three
  cases (missing CL + empty body → reject `download`; explicit `CL: 0` +
  empty body → allowed; missing CL + non-empty body → succeeds).

### From `QA-R2.md` — P0/P1/NR closures

- **QA P0-1 SSRF Bypass A (IPv4-mapped IPv6) — CLOSED ✅**
  `attachments.ts:165-186` adds two regex pairs for the IPv4-mapped IPv6
  forms WHATWG URL parser produces:
  - dotted: `::ffff:N.N.N.N` and the fully-expanded `0:0:0:0:0:ffff:N.N.N.N`
  - hex tail: `::ffff:HHHH:HHHH` and `0:0:0:0:0:ffff:HHHH:HHHH`
  Hex tail is decoded back to dotted v4 (`hi >> 8`, `hi & 0xff`, etc.) and
  recurses through the existing v4 private-table — single source of truth.
  Malformed mapped forms fail closed (return `true` → treated as private).
  I cross-checked against `URL` normalisation manually: `[::ffff:127.0.0.1]`
  and `[0:0:0:0:0:ffff:7f00:1]` both normalise to `::ffff:7f00:1`, which the
  hex regex catches. ✅
  Tests: "R3 #2" exercises 8 distinct loopback / metadata / RFC1918 / CGN
  forms in both dotted and hex notation, plus the URL-form `assertSafeUrl`
  rejection for all 8, plus a public-IPv6 control (`2606:4700::1`) that must
  *not* be misclassified. The QA-R2 broken-pin test ("IPv4-mapped IPv6 in URL
  hostnames") is flipped in the same commit. ✅

  *Latent edge (informational, not blocking):* the fully-expanded form
  `0:0:0:0:0:ffff:7f00:1` passed *directly* to `isPrivateIp` (i.e. bypassing
  `assertSafeUrl`'s URL normalisation) currently returns `false`, because the
  regex `^(?:0:){0,5}:?:ffff:...` requires exactly the compressed `::ffff:`
  segment. This is not reachable via real URL input (WHATWG always
  compresses), and Node's `dns.lookup` always returns compressed IPv6, so no
  exploit path exists in the current call graph. Worth a one-line widening
  later, but does not block R3.

- **QA P0-1 SSRF Bypass B (redirect-to-internal) — CLOSED ✅**
  Same fix as R2-1 above. The QA broken-pin test is flipped to assert
  rejection. The `internalReached` assertion in the new test is the strongest
  possible proof — the loopback handler is *literally never invoked*. ✅

- **QA P0-3 CL-mismatch caveat (NR-2) — CLOSED ✅**
  `AttachmentError.reason` union (`attachments.ts:39`) gained two new entries:
  `"redirect_loop"` and `"download_truncated"`. Both sites that detect a
  declared-vs-actual size mismatch now produce `download_truncated`:
  - the post-stream check at `:520-525` (`written !== headerLen` when CL>0),
  - the pipeline `catch` at `:497-507` for the undici-`terminated` /
    socket-reset path, gated on `Number.isFinite(headerLen) && headerLen > 0`
    so genuine write-side I/O failures still surface as `io`.
  Test "R3 #8" uses `res.write(50 bytes); res.socket?.end()` to trigger the
  socket-reset path, and asserts `e.reason === "download_truncated"` strictly.
  The QA-R2 P0-3 broken-pin test now allows the new reason in its allow-list. ✅

- **QA P1-7 GC active-session unawareness — CLOSED ✅**
  `attachments-gc.ts` `sweepAttachments` gained an optional
  `activeSessionDirs?: ReadonlySet<string>` parameter; if a session dir is in
  the set, the entire dir is skipped (no readdir, no unlink). `startAttachmentGc`
  takes a `getActiveSessionDirs?: () => ReadonlySet<string>` callback so the
  set is *re-pulled every tick* (live state, not a snapshot — important for
  long-running processes).
  `Router` keeps `private activeSessionDirs = new Set<string>()` and
  `add(sessionDirKey)` before downloads start at `:197`, `delete(sessionDirKey)`
  in finally at `:363`. `start()` wires the callback at `:431-434`.
  Tests: "R3 #3" pins the dir → 0 removed → file survives; releases the dir →
  1 removed → file gone. A second test asserts `getActiveSessionDirs` is
  invoked ≥ 2 times across 180ms with 50ms interval (live state, not
  snapshot). ✅

  *Race/long-session analysis:* the same `sessionKey` cannot be processed
  concurrently because `SessionManager` serialises via the queue/drain loop;
  the recursive drain re-`add`s before the next download starts. The window
  between outer `delete` and recursive `add` is microseconds, far shorter
  than any practical GC tick. Long-running idle sessions (idle > TTL) lose
  files as designed — that matches operator expectation when they choose a
  tight TTL. Acceptable.

- **QA NR-1 empty-body — CLOSED ✅** (covered above under R2 boundary-case row.)

- **QA NR-2 CL-mismatch reason — CLOSED ✅** (covered above under QA P0-3.)

- **Deferred: magic-byte sniffing, Discord 5xx retry — DEFERRED with cause ✅**
  Both flagged `[DEFERRED]` in the QA test suite, both agreed by R2 reviewer.
  Not in R3 scope. ✅

---

## New issues introduced by R3 fixes

None that block production.

Two informational notes for the next round:

1. **`isPrivateIp` fully-expanded mapped form** — `0:0:0:0:0:ffff:7f00:1`
   passed directly to `isPrivateIp` returns `false`. Not reachable via
   `assertSafeUrl` (WHATWG URL normalises) or Node DNS (always compressed).
   Hardening would be a one-liner widening the regex; defer to a future tidy.

2. **`assertSafeUrl` return type widened** — now returns
   `{ addresses: string[] }`. No callers in `src/` consume it yet. Either use
   it for IP pinning later, or trim back to `Promise<void>`. Not a defect.

Reviewed for collateral damage and found none in:
- the existing redactToken behaviour (`encodeURI` does not introduce
  `bot<digits>:` patterns), `tests/telegram-token.test.ts` re-passes;
- the SessionManager / drain loop (`activeSessionDirs.add/delete` are
  Set ops with no ordering hazard against `sessions.drain`);
- the partial-failure cleanup (`downloaded` is reset to `[]` after the
  attachment-download catch's unlink, so the AI-failure finally cannot
  double-unlink);
- streaming size guard (`Number.isFinite` already gated all the size
  comparisons; switching to NaN for missing CL is invisible to it).

---

## New-test quality review (R3 additions)

`tests/r3-fixes.test.ts` — **16 cases, 7 describe blocks, 1:1 mapped to FIX-R3**.

- All integration tests stand up real `http.createServer` instances and
  exercise the actual `fetch` + `pipeline` + `Readable.fromWeb` path. No
  `fetchImpl` mock theatre.
- "R3 #1 redirect chain longer than MAX_REDIRECT_HOPS" uses a real
  self-referential 302 server and asserts the visit count is `≤ 4` (1 initial
  + 3 follows) — proves the hop counter is honored, not just thrown.
- "R3 #1 302 → loopback rejected" uses two separate servers (public-style on
  one port, loopback handler on another) and the strongest-possible assertion
  `assert.strictEqual(internalReached, false)`.
- "R3 #2 IPv4-mapped IPv6" exercises 8 distinct ranges (loopback, cloud
  metadata, RFC1918 across all three, CGN) in both dotted and hex notation,
  plus a public-IPv6 negative control. Catches both the original bug and any
  regression that tries to whitelist v6.
- "R3 #3 GC" uses real filesystem (`mkdirSync`, `writeFileSync`, `utimesSync`)
  and the real `sweepAttachments` — no mocked clock.
- "R3 #4 empty body" is three real-server cases covering missing-CL/0/non-
  empty.
- "R3 #6 Router cleanup" uses the real `Router` class with a real
  `http.createServer` and walks `.attachments/` after the fact.
- "R3 #7 Telegram encoding" feeds non-ASCII into `resolveTelegramFileUrl` and
  verifies the resulting URL parses.
- "R3 #8 truncation" uses `res.socket?.end()` to genuinely truncate the
  TCP connection mid-body and asserts the strict `download_truncated` reason.

The 5 flipped QA-R2 broken-pin tests confirm the bypasses they pinned are
gone (rather than just adding a parallel green test next to a permanently
broken pin).

No test is so heavily mocked it would still pass if the production code
quietly regressed.

---

## Production go/no-go recommendation

**GO for production. APPROVED.**

The gateway is ready to be exposed to untrusted senders for the
attachment-handling code path:

- SSRF guard now survives every URL-borne attack vector R1/R2/QA flagged
  (direct private IP, IPv4-mapped IPv6 in both notations, redirect-to-
  internal, redirect loops, obfuscated v4, IP literals, and the residual
  DNS-rebinding window with documented and accepted trade-off).
- Disk hygiene is sound across all three failure modes
  (attachment-download fail, AI-invoke fail, idle GC) with no double-
  unlinks and no orphaned files.
- Telegram bot-token isolation is unchanged (still verified by R2's
  end-to-end checks) and the new `encodeURI(filePath)` is pure
  defense-in-depth.
- Error-reason taxonomy is now complete: callers can branch on
  `redirect_loop` and `download_truncated` instead of guessing at `io`.
- 265 / 265 tests pass, with the new tests being genuine (real
  network/filesystem), not mock theatre.

Minor follow-ups for a future tidy round (none blocking):
- Widen the `isPrivateIp` regex to also catch the (currently unreachable)
  fully-expanded `0:0:0:0:0:ffff:HHHH:HHHH` form for direct calls.
- Either use the new `assertSafeUrl` `{ addresses }` return value to pin to
  the validated IP (defeats DNS rebinding completely), or trim the return
  type back to `void`.
- Pick up the deferred magic-byte sniff and Discord 5xx single retry when
  the next attachment-handling sprint rolls around.

---

## Push + deploy go-ahead?

**YES — push and deploy.**

- 16 commits ahead of `origin/main`, working tree clean, no secrets in the
  diff (git log audited; only code + docs + tests).
- `npm run build` ✅, `npm test` ✅ 265 / 265.
- All R2 + QA-R2 must-fix items genuinely closed; no new issues introduced
  that meet the bar for blocking.
- Two informational follow-ups noted above; neither warrants gating the
  deploy.

Recommend a normal `git push origin main` followed by the standard deploy
flow. Monitor first ~24h of production traffic for any unexpected
`reason: "redirect_loop"` or `reason: "download_truncated"` rates — those
are new error codes and will need to be reflected in any dashboard alerts /
SLO definitions.
