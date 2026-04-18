# QA R2 — Multimodal Attachments (post-fix)

## Test count: 208 → 243

- Baseline (R1+QA-R1, post-Coder fixes): **208 / 208 ✅** (re-verified before adding new tests)
- New file: `tests/qa-r2-attachments.test.ts` — **35 new test cases** in **14 suites**
- Final: **243 / 243 ✅** (`npm test`), `npm run build` ✅
- 13 of the 35 new tests deliberately *pin* documented broken/known/deferred
  behaviour (marked `[BROKEN]`, `[KNOWN LIMITATION]`, or `[DEFERRED]` in the
  test name). Each carries a comment explaining impact + suggested fix so the
  next coder can flip them to "expect rejection" once fixed.

## P0 closure verification

### P0-1 SSRF — **❌ BROKEN** (two distinct bypasses)
- **Bypass A — IPv4-mapped IPv6 hostnames slip past `isPrivateIp`.**
  - The WHATWG URL parser normalizes `[::ffff:127.0.0.1]` to the hex-tail form
    `[::ffff:7f00:1]`. `isPrivateIp` only matches the *dotted* form via
    `/^::ffff:([0-9.]+)$/`. After `URL` parsing the dotted form is gone, so
    every IPv4-mapped IPv6 host (loopback, RFC1918, link-local, cloud
    metadata) is accepted.
  - Repro (matches `tests/qa-r2-attachments.test.ts → "QA-R2 P0-1 SSRF: IPv4-mapped IPv6 in URL hostnames"`):
    ```ts
    delete process.env.ATTACHMENT_ALLOW_PRIVATE_IPS;
    await assertSafeUrl("http://[::ffff:7f00:1]/x");        // ACCEPTED — should reject (loopback)
    await assertSafeUrl("http://[::ffff:a9fe:a9fe]/x");     // ACCEPTED — should reject (169.254.169.254)
    await assertSafeUrl("http://[::ffff:0a00:0001]/x");     // ACCEPTED — should reject (10.0.0.1)
    await assertSafeUrl("http://[::ffff:127.0.0.1]/x");     // ACCEPTED — URL normalises to hex form
    ```
  - **Severity: HIGH** — direct cloud-metadata reach if the gateway runs on
    EC2/GCE with IMDSv1, or any path to gateway-local services. Equivalent
    to having no SSRF guard for any attacker who knows IPv6 syntax.
  - **Fix:** in `isPrivateIp`, also detect the hex IPv4-mapped form. Either
    add a regex `/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i`, decode the two
    16-bit halves to four octets, and recurse; or normalise via
    `Buffer.from(net.isIPv6 ? expand(host) : host)` before classification.

- **Bypass B — fetch follows 30x redirects to internal hosts.**
  - `assertSafeUrl` runs only on the *initial* URL. The downloader calls
    `fetch(url, { headers, signal })` with the default `redirect: "follow"`.
    A public host returning `302 Location: http://127.0.0.1:.../secret` is
    auto-followed and the internal endpoint is reached.
  - Repro (matches `… → "QA-R2 P0-1 SSRF: redirect-to-internal"`):
    ```text
    public CDN  →  302 Location: http://127.0.0.1:N/secret  →  internal handler reached, 5 bytes returned
    ```
  - **Severity: HIGH** — the FIX-R2 doc explicitly named `redirect: "manual"`
    as the recommended fix but the implementation does not pass it.
  - **Fix:** `fetch(url, { redirect: "manual", headers, signal })`. On 30x,
    extract the `Location` header, run `assertSafeUrl` on the resolved URL,
    bound the redirect chain (e.g. ≤ 5 hops), then re-issue.

- **Control: obfuscated IPv4 forms ARE blocked.** `0177.0.0.1`, `2130706433`,
  `0x7f.0.0.1`, `0`, `0.0.0.0` are all caught because the WHATWG URL parser
  normalises them to dotted IPv4 before `assertSafeUrl` sees the host. ✅

### P0-2 Telegram bot-token isolation — **VERIFIED ✅**
- Token never appears in `InboundAttachment.url` (placeholder is
  `tg-file://<file_id>`).
- `redactToken` survives short / empty / undefined / uppercase-prefix / URL
  path-component variants.
- Forced-failure download path: `error.message`, `error.stack`, and
  `error.cause` chain were all grepped — no token leak in any of them.
- `resolveTelegramFileUrl` honors a 200ms timeout instead of hanging.
- Verified by suite `QA-R2 P0-2 Telegram token: error paths never leak the token`
  (4 cases).

### P0-3 Content-Length integrity — **VERIFIED with caveat ✅**
- Server declares 500 / sends 50, then closes the socket: rejected as
  `AttachmentError` with no leftover file. ✅
- Server declares 100 / sends 99, then closes: rejected as `AttachmentError`
  (path: undici reports `terminated` → wrapped `io`). ✅
- **Implementation note:** the Coder's explicit `written !== headerLen`
  check at the bottom of `downloadAttachment` is in practice **only
  reachable for chunked-transfer responses that EOF cleanly before reaching
  the declared length**. For plain `Content-Length` truncation, undici
  rejects the stream with `terminated` first, surfacing through the
  `pipeline()` `catch` as `reason: "io"`. The security guarantee is honored
  either way (the file is never accepted), but the user-facing message and
  `reason` field differ from the documented behaviour. Worth documenting.
- **[KNOWN LIMITATION] declared 0, server streams body**: undici stops
  reading at `Content-Length: 0`, so the streamed bytes are silently lost
  and a 0-byte file is produced. Documented by the Coder; pinned by test.

### P0-4 Queue / attachments interaction (QA-7.2) — **VERIFIED ✅**
- The coder's `router-attachments.test.ts` only checked filenames appeared
  in *some prompt* (substring match). Deeper test counts actual files on
  disk: 3 quick same-session messages × 3 distinct attachments each →
  **9 files** under `<baseDir>/.attachments/<sessionHash>/`. None silently
  coalesced. ✅

### P0-5 `processMessage` returns `false` on attachment failure — **VERIFIED ✅**
- Coder's existing test in `router-attachments.test.ts` already asserts the
  ❌ reaction without ✅. Re-run as part of the regression baseline.

### P0-6 Multi-attachment partial-failure cleanup — **VERIFIED ✅**
- Same — Coder's test walks `.attachments/` after a 2-of-2 partial failure
  and asserts no leftover `.png` files. Confirmed green.

## P1 closure verification

### P1-7 Disk GC — **PARTIAL ✅ / 1 design gap ❌**
- TTL math, ATTACHMENT_TTL_HOURS env override, 0-disabled, empty-dir
  cleanup, missing-dir tolerance, lifecycle: all green. ✅
- **[BROKEN] Active-session unawareness.** `sweepAttachments` walks the
  `.attachments/` tree purely by `mtime`. There is no map of "which session
  is currently alive." A long conversation (or any TTL setting < session
  duration) loses the attachments mid-conversation:
  ```ts
  // file mtime backdated 2h, TTL = 1h
  const removed = await sweepAttachments(baseDir, 3600 * 1000);  // returns 1
  // file is gone even though the session it belongs to is still active
  ```
  - Severity: MEDIUM — default 24h TTL is forgiving, but operators who set a
    tighter TTL (or who keep multi-day sessions) will see attachments
    disappear without warning.
  - Fix: either `utimes` the file on every read (so mtime tracks last-use),
    or expose a `Router.activeSessionKeys()` and skip those dirs in the
    sweep.
- **mtime, not atime.** Verified by test: an `atime=now, mtime=2h ago` file
  is still removed. Documents the time-source choice.

### P1-8 Adapter-trust laundering (QA-5.2) — **VERIFIED ✅**
- adapter `image/png` + server `video/mp4` → reject (`reason: "mime"`). ✅
- adapter `image/png` + server `application/zip` → reject (`reason: "mime"`). ✅
- adapter `image/png` + server `image/png` → accepted (control). ✅
- (Note: `text/html` would have *passed* my first version of this test
  because the default whitelist contains `text/`. That's a whitelist policy
  question, not a P1-8 regression — the code correctly applies the
  configured policy.)

## New regressions found

### NR-1 Empty-body guard misfires when Content-Length header is absent — **MEDIUM**
- `downloadAttachment`:
  ```ts
  const headerLen = Number(res.headers.get("content-length") ?? "");
  // ...
  if (written === 0 && !(Number.isFinite(headerLen) && headerLen === 0)) {
    throw "Empty response body";
  }
  ```
- `Number("")` returns **`0`**, not `NaN`. So when the server omits
  `Content-Length` entirely AND the body is empty (chunked encoding / HEAD-
  like 200 / network glitch), `headerLen === 0` is true, the guard skips,
  and the request is silently accepted as a legitimate 0-byte attachment.
- Repro: `QA-R2 new-hunt: response.body empty edge` test pins the broken
  behaviour with `assert.strictEqual(out.size, 0)`.
- Severity: LOW–MEDIUM — a buggy upstream can deliver an empty payload that
  the gateway hands to the AI, which then hallucinates over an empty file.
- Fix: change to
  ```ts
  const headerLenRaw = res.headers.get("content-length");
  const headerLen = headerLenRaw == null ? NaN : Number(headerLenRaw);
  ```

### NR-2 CL-mismatch error surfaces as `reason: "io"` (not `download`)
- See P0-3 caveat above. Not a security regression — the file is still
  rejected — but the documented behaviour ("`AttachmentError(download)`
  with a `size mismatch` message") only fires for chunked responses that
  EOF cleanly. Plain Content-Length truncation gets `io: terminated`
  instead.

## Deferred items — exploit attempts

| Item | Status | Notes |
|---|---|---|
| Magic-byte sniffing (e.g. PE/ELF as `.png`) | DEFERRED, exploit confirmed | A `.png`-named file with `MZ...PE\0\0` bytes and adapter MIME `image/png` + server MIME `image/png` is accepted. Limited blast radius (the AI agent doesn't execute it), but any downstream tool that opens it as an image will misbehave. Pinned by `[DEFERRED]` test. |
| Discord URL 5xx single-hit retry | DEFERRED, exploit confirmed | A single 502 response is reported as download failure with no retry (`hits === 1`). Acceptable; documented. |

## Verdict: **CONDITIONAL_PASS** with two HIGH-severity SSRF carve-outs to fix before next round

Functionally R2 is a solid step up — token isolation, queue/attachment
interaction, partial-failure cleanup, GC lifecycle, and the bulk of the
SSRF guard work as advertised. But the SSRF guard has two material holes
(IPv4-mapped IPv6, redirect-to-internal) that re-open the original P0-1
attack surface for any attacker who knows what to type. These need to land
before this is exposed to untrusted senders.

## Production readiness

**Not ready for untrusted senders without R3.** Specifically:

1. **MUST FIX before exposing to untrusted senders (HIGH):**
   - SSRF Bypass A — IPv4-mapped IPv6 hostname classification. ~10 lines
     in `isPrivateIp`.
   - SSRF Bypass B — `redirect: "manual"` + per-hop `assertSafeUrl`.
     ~30 lines in `downloadAttachment`.

2. **SHOULD FIX (MEDIUM):**
   - NR-1 empty-body guard — 2-line fix to use `NaN` for missing CL header.
   - GC active-session awareness — `utimes` files on read, or skip live
     session dirs.

3. **NICE TO HAVE (LOW):**
   - Align CL-mismatch error reason to `download` for parity with the
     documented contract.
   - Magic-byte sniff (still optional, blast radius is small).
   - Discord 5xx single retry (cosmetic robustness).

For trusted-sender deployments (e.g. only the operator and known internal
users send attachments) the current build is acceptable, with the caveat
that anyone who *can* set an attachment URL gets cloud-metadata reach via
the IPv4-mapped IPv6 form.
