# QA R1 — Multimodal Attachments

## Test count
- New QA test cases: **44** (file: `tests/qa-attachments.test.ts`)
- Full suite after wire-in: **139** (was 95) — `tests/attachments.test.ts` + `tests/router.test.ts` re-run unchanged and still green.

## Pass rate
- **139 / 139 ✅** (100%)
- `npm run build` ✅
- `npm test` ✅

## Verdict
**CONDITIONAL_PASS**

The module is functionally correct for the happy path and the obvious adversarial cases (path traversal, oversize via Content-Length / streaming guard, MIME whitelist, fail-closed defaults). Two real defects were uncovered that don't crash anything but weaken the security/integrity story enough to warrant a follow-up before this is exposed to untrusted senders.

---

## Failed scenarios

No assertion failures in the final run, but the following tests deliberately *document* defective behaviour as the "expected" outcome (search the file for `KNOWN GAP` / `KNOWN BEHAVIOUR`):

| ID | Phenomenon | Expected (ideal) | Actual | Severity |
|---|---|---|---|---|
| QA-3.3 | Server declares `Content-Length: 50`, sends 500B body | Detect mismatch / reject (integrity) | undici stops at declared length, file silently truncated to 50B, success returned | **Medium** — silent data loss; an attacker can serve a malformed asset that the AI then reasons over |
| QA-4.5 | Attachment URL points to `127.0.0.1:<port>` | Reject loopback (or all RFC1918 + link-local) | Downloaded normally | **Medium** — adapters are the trust boundary, but a Slack/Discord URL that 30x-redirects to loopback would still fetch. SSRF risk against gateway-local services |
| QA-4.6 | URL is `http://169.254.169.254/...` (cloud metadata) | Reject | `fetch()` invoked with no host validation | **High on cloud (EC2/GCE)** — anyone able to influence an attachment URL can read instance metadata if the gateway runs on a VM with IMDSv1 |
| QA-5.2 | Adapter declares `image/png`, server returns `video/mp4` body | Re-validate header MIME after fetch | Adapter MIME wins (`att.mimeType ?? headerMime`); header is never checked | **Low–Medium** — assumes adapter is trustworthy; a buggy adapter can launder content past the whitelist |
| QA-6.3 | Two distinct sessionIds `"a/b"` and `"a_b"` | Two distinct directories | Both sanitize to `a_b` and share a directory | **Low** — cross-session info leak only if attackers can both pick adjacent sessionIds AND access the local filesystem |
| QA-7.2 | 3 concurrent messages with attachments in same session | All 3 attachments downloaded and presented to AI | Queue coalesces #2+#3 into one drain whose `msg.attachments` is from the *original* msg only — queued attachments are **silently dropped** | **Medium** — feature regression: user sends 3 images quickly, AI only sees the 1st |
| QA-1.4 | `CON.txt` / `PRN` / `NUL` etc. | Renamed/blocked on Windows | Preserved as-is | **Low** — only impacts Windows hosts (gateway is Linux-targeted) |
| QA-6.4 | Two attachments downloaded in same `Date.now()` ms | Distinct paths | `Date.now()-name` collides → second overwrites first (no random suffix) | **Low** — race window ~1ms; rare but real for batched downloads |

---

## Edge cases discovered (all green)

**Filename sanitization:** ✅ Path traversal (`../..`), absolute paths (`/etc/shadow`, `C:\…`), null/control chars, 5KB names, emoji (`🔥火焰.png`), hidden-file dots (`....hidden`), URL-encoded traversal (`%2f`) — all neutralized correctly. The `path.resolve` defense-in-depth check on the per-session dir is solid.

**MIME boundaries:** ✅ Prefix entry `image/` correctly does NOT match the bare string `image`. Exact entry `application/pdf` correctly does NOT match `application/pdf-extra` or `application/pdfx`. Charset parameters stripped (`text/plain; charset=utf-8` → allowed). Case folding works. Empty / whitespace / `;charset=utf-8` (no major type) all reject (fail-closed). Octet-stream not in the default whitelist so unknown content correctly rejected.

**Sizes:** ✅ Exactly-at-limit succeeds. limit+1 via Content-Length rejected. Unknown Content-Length still policed by streaming guard. Zero-byte file accepted.

**HTTP errors:** ✅ 4xx/5xx surfaced as `download` reason. Network errors caught. 302 redirects followed transparently (redirect to allowed type works).

**Path isolation:** ✅ Distinct sessionIds → distinct dirs; sessionId traversal cannot escape `<baseDir>/.attachments/`.

**Router integration:** ✅ Rate-limit blocks the 11th message in a window. Oversize attachment short-circuits AI invocation with an `❌` reply. Multi-attachment batch: first failure aborts whole turn — AI is not invoked with a partial set.

---

## Recommendations for Reviewer / Coder (priority order)

### P0 — fix before exposing to untrusted senders
1. **SSRF allowlist** in `downloadAttachment` (`QA-4.5`, `QA-4.6`).
   - Resolve hostname; reject if it resolves to RFC1918 (`10/8`, `172.16/12`, `192.168/16`), loopback (`127/8`), link-local (`169.254/16`), `::1`, `fc00::/7`, `fe80::/10`.
   - Optionally restrict scheme to `https:` (and `http:` only for explicit dev/test).
   - Pass `redirect: "manual"` to fetch, follow yourself, re-validate each hop.

2. **Queue + attachments interaction** (`QA-7.2`).
   - In `Router.processMessage` drain loop, the synthetic message reuses original `msg.attachments` (line ~286), so queued attachments are dropped. Either:
     - download attachments at *enqueue* time and stash them on the queued entry, or
     - widen `QueuedMessage` to carry the queued message's attachments, and download in the drain loop.

### P1 — close the integrity / spoofing holes
3. **Content-Length truncation defense** (`QA-3.3`).
   - After streaming completes, if a Content-Length header was present, assert `written === headerLen`; otherwise raise `download` / `io`. Stops silent truncation.

4. **Re-check header MIME even when adapter declared one** (`QA-5.2`).
   - Tighten to `if (headerMime && !isMimeAllowed(headerMime, …)) reject`. Adapter trust + server trust should be AND'd, not OR'd.

### P2 — hygiene
5. **Filename collision suffix** (`QA-6.4`): switch `${Date.now()}-${name}` → `${Date.now()}-${randomBytes(4).toString("hex")}-${name}`.
6. **SessionId collision** (`QA-6.3`): hash the sessionId (e.g. sha1 first 16 chars) instead of `sanitizeFilename`. Eliminates collision and removes the chance of two sessions sharing a dir.
7. **Windows reserved names** (`QA-1.4`): if cross-platform support is in scope, prefix `_` to `CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]` (case-insensitive) basenames.
8. Consider a per-attachment timeout (`AbortController` + `setTimeout`) — currently a slow upstream can stall a turn until the client-side TCP/keepalive gives up.

---

## Did the QA find anything the Reviewer missed?

Reviewer's static pass would likely catch (1) SSRF allowlist gap and (8) timeout. The dynamic adversarial pass surfaced three findings that are hard to spot from static review alone:

- **QA-3.3 silent truncation** — only visible by actually serving a lying Content-Length. The streaming guard *looks* correct in source.
- **QA-5.2 adapter-trust laundering** — looks fine in code (`att.mimeType ?? headerMime`) until you ask "what if both are set and disagree?"
- **QA-7.2 queued-attachment loss** — only visible from end-to-end interaction between the rate-limit / queue / attachment paths. The router test suite exercises queueing and attachments separately but never together.

Recommend the coder address the P0 + QA-7.2 + QA-3.3 items before this lands in any production-facing channel.
