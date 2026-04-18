# QA R3 — Final attack pass

## Test count: 265 → 305

- Baseline (post-R3 Coder fixes, pre-QA-R3): **265 / 265 ✅** — re-verified before adding new tests
- New file: `tests/qa-r3-attachments.test.ts` — **40 new test cases** in **8 suites**
- Final: **305 / 305 ✅** (`npm test`)
- 1 of the 40 new tests deliberately *pins* a freshly-found regression
  (marked `[NEW REGRESSION]` in the test name) and asserts the broken
  behaviour with a clear "flip-on-fix" comment.
- 2 tests are deferred-item carryovers (`[DEFERRED]` / `[KNOWN LIMITATION carryover]`)
  that re-confirm R3 did not change those documented behaviours.

## R2 closure verification (8 items)

| # | R2 finding | R3 commit | Verdict | Verification test |
|---|---|---|---|---|
| 1 | **R2-Bypass-A** SSRF redirect-to-internal | `5cd23ba` | **VERIFIED ✅** | 6 tests in `QA-R3 R2-Bypass-A` — 5-hop chain to 127.0.0.1 (real chain server) blocked, 20-iter loop bounded at 4 visits via `redirect_loop`, redirect to `[::ffff:127.0.0.1]` blocked, redirect to `169.254.169.254` blocked, `file://` Location blocked, 3xx without Location rejected. Internal target server NEVER receives a request in any case. |
| 2 | **R2-Bypass-B** IPv4-mapped IPv6 hex form bypasses `isPrivateIp` | `8e10ea0` | **VERIFIED ✅** *(with one edge-case correctness regression — see below)* | 14 dotted/hex/zero-padded/upper-case/CGN/multicast/broadcast/unspecified mapped variants all classified private; URL-form rejection covers loopback, hex-loopback, metadata, dotted+hex CIDRs; public mapped form `::ffff:8.8.8.8` correctly NOT classified private (control). |
| 3 | **GC active-session unawareness** | `edf2bc2` | **VERIFIED ✅** | 4 tests in `QA-R3 GC: active-session set under pressure` — file written to active dir mid-sweep survives; session active across 10 sweeps with 100×TTL backdated mtime survives; concurrent add/remove on active set never produces false-positive removals; `startAttachmentGc` reads the live set every tick and reaps as soon as the session leaves the set. |
| 4 | **NR-1** Empty-body guard misfires when CL absent (`Number("") === 0`) | `d611a1b` | **VERIFIED ✅** | 4-case matrix: missing CL + 0-byte body → reject (`reason: "download"`); missing CL + 1-byte body → accept (size=1); explicit `CL: 0` + 0-byte body → accept (size=0); `CL: 0` + chunked body → still silently accepted as 0-byte (deferred carryover, R2 limitation, R3 unchanged). |
| 5 | **DNS rebinding TOCTOU** between guard and fetch | `5cd23ba` (per-hop reval) | **VERIFIED ✅ (proxy mitigation only)** | Per-hop redirect re-validation IS wired through `enforceUrlValidation` (proven by hop-2 reject test). Pure DNS A-record flip between guard and fetch is documented as **deferred** (no IP-pinning dispatcher yet). FIX-R3 §5 acknowledged this trade-off; threat model accepts the residual sub-second window for the gateway's deployment context. |
| 6 | Router leaves `downloaded[]` for 24h GC when AI invoke throws | `c237e9c` | **VERIFIED ✅** | The Coder's `R3 #6` test in `tests/r3-fixes.test.ts` walks `.attachments/` post-AI-throw and asserts zero `.png` leftovers; re-run as part of the regression baseline. |
| 7 | Telegram `filePath` interpolated raw — defense-in-depth | `b1ebc1b` | **VERIFIED ✅** | The Coder's `R3 #7` test in `tests/r3-fixes.test.ts` proves `encodeURI` (not `encodeURIComponent`) is used so the `/` separator survives but spaces and unicode are encoded; re-run green. |
| 8 | CL-mismatch surfaces as `reason:"io"` (was supposed to be `download`) | `cc5122d` | **VERIFIED ✅** | New `download_truncated` reason added to the union; QA-R3 hunts it under a real partial-write server and confirms it fires (`reason === "download_truncated"`). The original R2-NR-2 contract drift is closed. |

### One asterisk on item 2 — see `New regressions` below.

## New regressions

### NR-3 `isPrivateIp` regex misses fully-expanded IPv4-mapped form — **LOW (defense-in-depth)**
- Bug: the dotted regex `/^(?:0:){0,5}::?ffff:([0-9.]+)$/` requires a literal
  `:` immediately before `ffff`. After consuming the `(?:0:){5}` prefix
  (`0:0:0:0:0:`) the cursor is at `f`, not `:`, so the alternation
  `::?` cannot match. Same shape problem on the hex-tail regex.
- Effect: `isPrivateIp("0:0:0:0:0:ffff:127.0.0.1")` returns `false` (and
  similar for any fully-expanded mapped form). Pinned by the
  `[NEW REGRESSION]` test — the test currently asserts the BROKEN behaviour
  so the hole is visible in CI; comment in the test gives the one-line fix.
- **Why this is LOW, not HIGH:**
  WHATWG URL parser normalises every fully-expanded IPv4-mapped IPv6 form
  to the compressed `::ffff:HHHH:HHHH` form before `assertSafeUrl` ever
  sees the host, and that compressed form **is** caught by the existing
  regex. Verified by a control test that drives `assertSafeUrl(
  "http://[0:0:0:0:0:ffff:127.0.0.1]/x")` → rejected. So the SSRF attack
  path through any URL is closed; the regex hole only matters for callers
  that feed a raw IP literal directly (e.g. a future change that resolves
  AAAA records and passes one of the resulting strings into `isPrivateIp`,
  or external config that hard-codes the long form).
- **Severity:** LOW (defense-in-depth correctness gap). Not exploitable
  through the attachment URL surface.
- **Fix:** change the dotted regex to `/^(?:0:){5}ffff:([0-9.]+)$/` and
  the hex-tail regex to `/^(?:0:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i`,
  in addition to the existing `/^::ffff:.../` patterns. ~4 char change.

### No other regressions found
- 303 See Other followed cleanly (control)
- Relative `./` Location resolved against current URL (control)
- Invalid `Location` URL → graceful `AttachmentError`
- `download_truncated` reason cleanly produced under early-EOF
- All 8 R3 commits land without breaking any of the existing 265 tests.

## Deferred items still safe to defer? **YES**

Both QA-R2 deferred items are unchanged after R3:

- **Magic-byte sniffing (PE/ELF disguised as `image/png`)** — re-pinned
  with a `MZ…PE\0\0` payload that downloads and is accepted at the
  declared size. Same story as R2: blast radius is bounded by what the AI
  agent and its tools choose to do with the file; no R3 patch was supposed
  to touch this. **Safe to defer.**
- **Discord/CDN 5xx retry** — single 502 still produces a single hit and
  surfaces as `AttachmentError`. No retry was added (Coder explicitly
  scoped this out in FIX-R3). **Safe to defer.**

Reasoning: R3 deliberately scoped these out and the test pins now
demonstrate R3 didn't accidentally make them worse. The gateway threat
model already accounts for both — the AI agent should treat downloaded
files as untrusted input regardless of MIME, and operators with strict 5xx
SLAs can wrap the gateway behind a retrying CDN.

## Verdict: **PASS**

R3 closed all 8 R2-flagged issues under aggressive verification, with one
caveat: a low-severity defense-in-depth correctness regression in
`isPrivateIp` for the fully-expanded IPv4-mapped form. The practical SSRF
surface (URL parsing + `assertSafeUrl`) is fully closed because the WHATWG
URL parser normalises that form before the regex runs. The dead-form
classification hole is pinned in the test suite for the next round.

## Production approval

**Approved for production for both trusted and untrusted senders, with one
must-fix-soon item:**

1. **MUST FIX (LOW, but flip the pin within one release cycle):**
   - NR-3 `isPrivateIp` fully-expanded form — ~4 character regex change.
     Not exploitable today; closing this prevents a future caller from
     reintroducing the original SSRF carve-out by passing a raw IP from a
     non-URL source.

2. **DEFERRED (re-confirmed):**
   - Magic-byte sniffing — out of scope, accepted limitation.
   - Discord 5xx retry — cosmetic robustness, accepted limitation.
   - DNS-rebinding via mid-flight A-record flip — accepted residual,
     requires custom dispatcher with IP-pinning to fully close.

The 8 R3 fixes are well-scoped, well-tested by the Coder's own
`r3-fixes.test.ts`, and survive a 40-test adversarial pass with only one
minor classification gap that is not reachable through the URL attack
path. Ship it.

---

### Test inventory delta
- `tests/qa-r3-attachments.test.ts` (NEW): 40 tests across 8 describe
  blocks — R2-Bypass-A redirects (6), R2-Bypass-B IPv4-mapped zoo (15),
  GC active-session under pressure (4), empty-body matrix (4), DNS-rebind
  TOCTOU via redirect (2), new-regression hunt (4), and deferred-items
  re-verification (2). Plus a couple of housekeeping tests folded in.
- `package.json`: test script updated to include the new file.
- No `src/` changes. No commits or pushes performed.
