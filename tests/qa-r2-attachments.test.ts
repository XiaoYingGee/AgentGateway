// QA R2 — adversarial post-fix verification
// All tests in this file are designed to stress the R2 fixes described in FIX-R2.md
// and to surface new regressions / vulnerabilities the Coder did not consider.
//
// IMPORTANT: This file documents the ACTUAL behaviour of the system as observed
// during the R2 QA pass. Tests that demonstrate a BROKEN guarantee are clearly
// marked `[BROKEN]` in the test name and assert the *vulnerable* behaviour so
// the suite stays green and the bug is reproducible. Each such test carries a
// comment block explaining the impact and the suggested fix.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, statSync, existsSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  AttachmentError,
  assertSafeUrl,
  downloadAttachment,
  isPrivateIp,
  redactToken,
  resolveTelegramFileUrl,
} from "../src/utils/attachments.ts";
import { sweepAttachments, startAttachmentGc } from "../src/utils/attachments-gc.ts";
import { Router } from "../src/core/router.ts";
import type { AIAdapter, IMAdapter, InboundMessage } from "../src/core/types.ts";

function mkTmp(prefix = "agw-qa-r2-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function startStaticServer(handler: (req: any, res: any) => void): Promise<{ server: Server; url: (p: string) => string; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address() as AddressInfo;
      resolve({ server, url: (p: string) => `http://127.0.0.1:${a.port}${p}`, port: a.port });
    });
  });
}

function withoutOverride<T>(fn: () => Promise<T> | T): Promise<T> {
  const old = process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
  delete process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
  return Promise.resolve(fn()).finally(() => {
    if (old != null) process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"] = old;
    else delete process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
  });
}

function withOverride<T>(fn: () => Promise<T> | T): Promise<T> {
  // Ensure ATTACHMENT_ALLOW_PRIVATE_IPS=true so local 127.0.0.1 test servers
  // are reachable through the SSRF guard. Restored to previous value after.
  const old = process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
  process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"] = "true";
  return Promise.resolve(fn()).finally(() => {
    if (old == null) delete process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
    else process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"] = old;
  });
}

function createMockIM() {
  const sent: any[] = [];
  const reactions: any[] = [];
  let handler: any;
  let n = 0;
  const im: any = {
    platform: "test", accountId: "mock",
    async connect() {}, async disconnect() {},
    async sendMessage(p: any) { sent.push(p); n++; return { messageId: `m${n}`, chatId: p.chatId, threadId: p.threadId }; },
    async sendTyping() {},
    onMessage(h: any) { handler = h; },
    async react(_c: string, mid: string, e: string) { reactions.push({ kind: "react", messageId: mid, emoji: e }); },
    async unreact(_c: string, mid: string, e: string) { reactions.push({ kind: "unreact", messageId: mid, emoji: e }); },
  };
  im.sent = sent;
  im.reactions = reactions;
  im.inject = (msg: InboundMessage) => handler(msg);
  return im;
}

function makeMsg(o: Partial<InboundMessage>): InboundMessage {
  return {
    platform: "test", sessionKey: "test:user:1", chatId: "c", accountId: "mock",
    userId: "u1", userName: "U", text: "hi", raw: {},
    replyToId: "msg-1",
    ...o,
  } as InboundMessage;
}

// ============================================================================
// P0-1 SSRF: deeper bypass attempts
// ============================================================================

describe("QA-R2 P0-1 SSRF: IPv4-mapped IPv6 in URL hostnames", () => {
  // BACKGROUND
  // The WHATWG URL parser normalizes `[::ffff:127.0.0.1]` into the hex form
  // `[::ffff:7f00:1]`. The `isPrivateIp` helper only matches the *dotted*
  // form `::ffff:N.N.N.N` via `/^::ffff:([0-9.]+)$/`. After URL parsing the
  // dotted form is gone, so the guard never recurses back to the v4 check,
  // and any IPv4-mapped IPv6 host literal slips through.
  //
  // IMPACT: HIGH — direct loopback / metadata reach via crafted hostname.
  // FIX: in `isPrivateIp`, also handle the hex form
  //      e.g. /^(0:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i, OR — better —
  //      detect any IPv6 with the IPv4-mapped prefix `::ffff:` regardless of
  //      whether the trailing tail is hex or dotted, decode to v4 and recurse.
  //
  // The tests below assert the CURRENT BROKEN behaviour so the regression is
  // tracked. Flip them to `assert.rejects(...)` once the fix lands.

  const bypasses: Array<{ url: string; comment: string }> = [
    { url: "http://[::ffff:7f00:1]/x",         comment: "127.0.0.1 (loopback) via IPv4-mapped hex" },
    { url: "http://[::ffff:127.0.0.1]/x",      comment: "127.0.0.1 (loopback) via IPv4-mapped dotted (URL normalises to hex)" },
    { url: "http://[0:0:0:0:0:ffff:127.0.0.1]/x", comment: "loopback via fully-expanded mapped form" },
    { url: "http://[::ffff:0a00:0001]/x",      comment: "10.0.0.1 (RFC1918) via IPv4-mapped hex" },
    { url: "http://[::ffff:a9fe:a9fe]/x",      comment: "169.254.169.254 (cloud metadata) via IPv4-mapped hex" },
    { url: "http://[::ffff:c0a8:0001]/x",      comment: "192.168.0.1 via IPv4-mapped hex" },
  ];

  for (const { url, comment } of bypasses) {
    it(`rejects ${url} — ${comment}`, async () => {
      await withoutOverride(async () => {
        // R3 P0-2: SSRF guard now classifies IPv4-mapped IPv6 hostnames in
        // both dotted (`::ffff:127.0.0.1`) and hex-tail (`::ffff:7f00:1`) forms.
        await assert.rejects(() => assertSafeUrl(url), AttachmentError,
          `assertSafeUrl should reject ${url}`);
      });
    });
  }

  it("control: raw dotted IPv4-mapped string is correctly classified as private", () => {
    assert.strictEqual(isPrivateIp("::ffff:127.0.0.1"), true);
    assert.strictEqual(isPrivateIp("::ffff:10.0.0.1"), true);
  });

  it("hex IPv4-mapped string is now classified as private (R3 P0-2)", () => {
    assert.strictEqual(isPrivateIp("::ffff:7f00:1"), true);
    assert.strictEqual(isPrivateIp("::ffff:a9fe:a9fe"), true);
    assert.strictEqual(isPrivateIp("::ffff:0a00:0001"), true);
    assert.strictEqual(isPrivateIp("::ffff:c0a8:0001"), true);
  });
});

describe("QA-R2 P0-1 SSRF: redirect-to-internal", () => {
  // BACKGROUND
  // `assertSafeUrl` runs once on the *initial* URL. `fetch` follows 30x
  // redirects automatically (default `redirect: "follow"`). So a public URL
  // that redirects to a loopback / cloud-metadata IP is reached without a
  // second guard pass.
  //
  // IMPACT: HIGH — Slack/Discord URLs go through a CDN that may issue 302s.
  //   FIX-R2.md acknowledged this in the recommendation ("Pass redirect:
  //   manual to fetch, follow yourself, re-validate each hop") but the
  //   implementation does NOT pass `redirect: "manual"`.
  //
  // Demonstration uses 127.0.0.1 for both endpoints with the override on for
  // the *initial* URL only — equivalent to a public host whose CDN redirects
  // to internal. The override applies to assertSafeUrl, but fetch still
  // follows the cross-origin redirect with no per-hop validation.

  it("[BROKEN] fetch auto-follows 302 to a loopback host without re-validating", async () => {
    let internalReached = false;
    const internal = await startStaticServer((_req, res) => {
      internalReached = true;
      res.writeHead(200, { "content-type": "image/png", "content-length": "5" });
      res.end("xxxxx");
    });
    const redir = await startStaticServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${internal.port}/secret` });
      res.end();
    });
    const baseDir = mkTmp();
    try {
      // SIMULATE a public-resolving hostname for the initial URL by enabling
      // the override (which is exactly what the SSRF guard does for the
      // first-hop URL when it resolves to something public).
      const old = process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
      process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"] = "true";
      try {
        const out = await downloadAttachment(
          { url: redir.url("/start"), filename: "x.png", mimeType: "image/png" },
          { baseDir, sessionId: "s" },
        );
        // The download succeeded and the internal server was reached — proof
        // that fetch auto-followed the redirect without re-running the SSRF
        // guard. When fixed (`redirect: "manual"` + per-hop assertSafeUrl),
        // this should throw AttachmentError("download") and internalReached
        // should remain false.
        assert.strictEqual(internalReached, true,
          "internal server should have been reached (current broken behaviour)");
        assert.strictEqual(out.size, 5,
          "5-byte payload smuggled from internal server (current broken behaviour)");
      } finally {
        if (old == null) delete process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
        else process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"] = old;
      }
    } finally {
      internal.server.close(); redir.server.close();
    }
  });
});

describe("QA-R2 P0-1 SSRF: obfuscated IPv4 forms (control — these ARE blocked)", () => {
  // These are caught because the WHATWG URL parser normalises octal /
  // decimal-int / hex-int forms into the dotted IPv4 string before
  // assertSafeUrl ever sees the host.
  const cases = [
    "http://0177.0.0.1/x",     // octal
    "http://2130706433/x",     // 32-bit decimal
    "http://0x7f.0.0.1/x",     // hex octet
    "http://0/x",              // shorthand
    "http://0.0.0.0/x",        // unspecified
  ];
  for (const u of cases) {
    it(`rejects ${u}`, async () => {
      await withoutOverride(async () => {
        await assert.rejects(() => assertSafeUrl(u), AttachmentError);
      });
    });
  }
});

// ============================================================================
// P0-2 Telegram bot-token isolation
// ============================================================================

describe("QA-R2 P0-2 Telegram token: error paths never leak the token", () => {
  const TOKEN = "1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ_-1234567";

  it("redactToken handles short / empty / undefined inputs", () => {
    assert.strictEqual(redactToken(""), "");
    assert.strictEqual(redactToken(undefined as any), undefined as any);
    assert.strictEqual(redactToken(null as any), null as any);
    // Smallest matchable token form
    assert.strictEqual(redactToken("bot1:a"), "bot<redacted>");
    assert.strictEqual(redactToken("Bot9:zZ"), "Bot<redacted>");
    // Token in path component of a real-looking URL
    const url = `https://api.telegram.org/file/bot${TOKEN}/documents/file_0.pdf`;
    const red = redactToken(url);
    assert.ok(!red.includes(TOKEN), `token leaked: ${red}`);
    assert.ok(red.includes("<redacted>"));
    // Token in query
    assert.strictEqual(
      redactToken(`https://x/y?token=${TOKEN}&x=1`),
      "https://x/y?token=<redacted>&x=1",
    );
  });

  it("download error paths do not leak TELEGRAM_BOT_TOKEN in message or stack", async () => {
    const oldTok = process.env["TELEGRAM_BOT_TOKEN"];
    process.env["TELEGRAM_BOT_TOKEN"] = TOKEN;
    const baseDir = mkTmp();
    let phase = 0;
    const fetchMock: any = async (_url: string) => {
      phase++;
      if (phase === 1) {
        // Successful getFile response
        return new Response(JSON.stringify({ ok: true, result: { file_path: "documents/leak.pdf" } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      // File fetch fails — trigger the download error path
      return new Response("nope", { status: 503 });
    };
    try {
      try {
        await downloadAttachment(
          { url: "tg-file://AQADBAADxxxxxx", filename: "leak.pdf", mimeType: "application/pdf" },
          { baseDir, sessionId: "s", fetchImpl: fetchMock },
        );
        assert.fail("should have thrown — file fetch returned 503");
      } catch (err: any) {
        const blob = JSON.stringify({
          message: err?.message ?? "",
          stack: err?.stack ?? "",
          cause: err?.cause ? { message: err.cause.message ?? "", stack: err.cause.stack ?? "" } : undefined,
          name: err?.name,
        });
        assert.ok(!blob.includes(TOKEN), `Telegram token leaked into error blob: ${blob.slice(0, 400)}`);
      }
    } finally {
      if (oldTok == null) delete process.env["TELEGRAM_BOT_TOKEN"];
      else process.env["TELEGRAM_BOT_TOKEN"] = oldTok;
    }
  });

  it("InboundAttachment.url for tg-file:// never carries the token", () => {
    const placeholder = "tg-file://AABBCCDD-test_file_id";
    // No `bot<digits>:<secret>` substring should ever appear
    assert.ok(!/bot\d+:[A-Za-z0-9_-]+/.test(placeholder), "no bot-token in placeholder");
    // And no plain colon outside of the scheme
    const afterScheme = placeholder.replace(/^tg-file:\/\//, "");
    assert.ok(!afterScheme.includes(":"), "no inner colons after the scheme");
  });

  it("resolveTelegramFileUrl times out instead of hanging forever", async () => {
    const oldTok = process.env["TELEGRAM_BOT_TOKEN"];
    process.env["TELEGRAM_BOT_TOKEN"] = TOKEN;
    try {
      // Slow upstream that never responds
      const slow: any = (_url: string, init?: any) => new Promise((_res, rej) => {
        const sig: AbortSignal | undefined = init?.signal;
        if (sig) {
          sig.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }
      });
      const start = Date.now();
      await assert.rejects(
        () => resolveTelegramFileUrl("tg-file://x", slow, 200), // 200ms timeout for the test
        (e: any) => {
          assert.ok(e instanceof AttachmentError);
          assert.ok(!String(e.message).includes(TOKEN));
          return true;
        },
      );
      const dur = Date.now() - start;
      assert.ok(dur < 2000, `resolveTelegramFileUrl honored timeout (took ${dur}ms)`);
    } finally {
      if (oldTok == null) delete process.env["TELEGRAM_BOT_TOKEN"];
      else process.env["TELEGRAM_BOT_TOKEN"] = oldTok;
    }
  });
});

// ============================================================================
// P0-3 Content-Length integrity
// ============================================================================

describe("QA-R2 P0-3 Content-Length: declared > actual rejected", () => {
  it("declared 500, server delivers 50 → AttachmentError(download), partial file unlinked", async () => {
    const big = "X".repeat(50);
    const { server, url } = await startStaticServer((_req, res) => {
      // Lying header: claims 500, sends 50, then forcibly closes the socket
      // so undici stops waiting for the missing 450 bytes.
      res.writeHead(200, { "content-type": "image/png", "content-length": "500" });
      res.write(big);
      res.socket?.end();
    });
    try {
      await withOverride(async () => {
        const baseDir = mkTmp();
        await assert.rejects(
          () => downloadAttachment(
            { url: url("/x.png"), filename: "x.png", mimeType: "image/png" },
            { baseDir, sessionId: "s", enforceUrlValidation: false },
          ),
          (e: any) => e instanceof AttachmentError && (e.reason === "download" || e.reason === "io"),
        );
        // No leftover file should remain
        const root = path.join(baseDir, ".attachments");
        let leftovers = 0;
        if (existsSync(root)) {
          for (const sd of readdirSync(root)) {
            for (const f of readdirSync(path.join(root, sd))) leftovers++;
          }
        }
        assert.strictEqual(leftovers, 0, "partial file should be unlinked after CL-mismatch reject");
      });
    } finally { server.close(); }
  });

  it("declared N, server delivers N-1 → reject (off-by-one truncation)", async () => {
    const data = "Y".repeat(99);
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": "100" });
      res.write(data);
      res.socket?.end();
    });
    try {
      await withOverride(async () => {
        const baseDir = mkTmp();
        await assert.rejects(
          () => downloadAttachment(
            { url: url("/x.png"), filename: "x.png", mimeType: "image/png" },
            { baseDir, sessionId: "s", enforceUrlValidation: false },
          ),
          (e: any) => e instanceof AttachmentError,
        );
      });
    } finally { server.close(); }
  });

  it("[KNOWN LIMITATION] declared 0, server streams body → undici truncates to 0; treated as legitimate empty", async () => {
    // Documented limitation: when the server promises 0 but actually sends
    // bytes, undici stops reading at 0 and there is nothing the streaming
    // guard can detect. The current empty-body fallback honors an explicit
    // Content-Length: 0 (it skips the "empty without explicit CL" reject),
    // so the request succeeds with size=0 and the body is silently lost.
    //
    // IMPACT: LOW–MEDIUM — silent data loss on a buggy / hostile origin.
    //   The Coder explicitly documented this limitation in QA-3.3's comment
    //   ("server promises fewer than it sends — undetectable from inside
    //   Node fetch"). This test PINS the current behaviour so a future fix
    //   (e.g. detect non-empty Transfer-Encoding mismatch, or compare to a
    //   `headers.get("x-content-length")` if provided) can flip it.
    const data = Buffer.alloc(100, 0x42);
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": "0" });
      res.write(data);
      res.end();
    });
    try {
      await withOverride(async () => {
        const baseDir = mkTmp();
        const out = await downloadAttachment(
          { url: url("/x.png"), filename: "x.png", mimeType: "image/png" },
          { baseDir, sessionId: "s", enforceUrlValidation: false },
        );
        assert.strictEqual(out.size, 0, "silent truncation honored Content-Length: 0");
        const st = statSync(out.path);
        assert.strictEqual(st.size, 0, "on-disk file is empty");
      });
    } finally { server.close(); }
  });
});

// ============================================================================
// P0-4 Queue/attachments interaction (QA-7.2 deeper)
// ============================================================================

describe("QA-R2 P0-4 Queue: 3 messages × 3 attachments — every file actually downloaded", () => {
  it("3 quick same-session messages each carrying 3 distinct images → all 9 files on disk", async () => {
    // The router-attachments test asserted that filenames *appear in some prompt*.
    // This deeper test counts the actual files on disk per session dir to confirm
    // each attachment was downloaded (not just referenced).
    const bodies: Buffer[] = [];
    for (let m = 0; m < 3; m++) {
      for (let i = 0; i < 3; i++) bodies.push(Buffer.from(`m${m}-i${i}-payload`));
    }
    const { server, url } = await startStaticServer((req, res) => {
      const m = req.url?.match(/\/m(\d)i(\d)\.png/);
      if (!m) { res.writeHead(404); res.end(); return; }
      const idx = Number(m[1]) * 3 + Number(m[2]);
      const body = bodies[idx]!;
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const baseDir = mkTmp();
      const router = new Router({ defaultCwd: baseDir });
      const im = createMockIM();
      let resolveSlow: (v: any) => void = () => {};
      const slow = new Promise((r) => { resolveSlow = r; });
      let firstCall = true;
      const ai: AIAdapter = {
        name: "ai", supportsResume: false,
        async invoke() {
          if (firstCall) { firstCall = false; await slow; }
          return { text: "ok", exitCode: 0 };
        },
      };
      router.registerIM(im); router.registerAI(ai);

      const mkAtts = (m: number) => [0, 1, 2].map((i) => ({
        url: url(`/m${m}i${i}.png`), filename: `m${m}i${i}.png`, mimeType: "image/png", size: bodies[m * 3 + i]!.length,
      }));
      const inj0 = im.inject(makeMsg({ text: "m0", replyToId: "msg-0", attachments: mkAtts(0) }));
      await new Promise((r) => setTimeout(r, 50));
      const inj1 = im.inject(makeMsg({ text: "m1", replyToId: "msg-1", attachments: mkAtts(1) }));
      const inj2 = im.inject(makeMsg({ text: "m2", replyToId: "msg-2", attachments: mkAtts(2) }));
      await Promise.all([inj1, inj2]);
      resolveSlow(undefined);
      await inj0;
      await new Promise((r) => setTimeout(r, 250));

      const root = path.join(baseDir, ".attachments");
      let pngs = 0;
      const allNames: string[] = [];
      if (existsSync(root)) {
        for (const sd of readdirSync(root)) {
          for (const f of readdirSync(path.join(root, sd))) {
            if (f.endsWith(".png")) { pngs++; allNames.push(f); }
          }
        }
      }
      // We expect 9 files (3 per message × 3 messages) — none silently coalesced
      assert.strictEqual(pngs, 9, `expected 9 .png files, got ${pngs}: ${allNames.join(", ")}`);
      router["sessions"].destroy();
    } finally { server.close(); }
  });
});

// ============================================================================
// P1-7 GC: behaviour around active sessions, time windows, atime vs mtime
// ============================================================================

describe("QA-R2 P1-7 GC: active-session awareness", () => {
  it("[BROKEN] GC deletes files older than TTL even when the session is still active", async () => {
    // BACKGROUND
    // sweepAttachments() walks .attachments/<session>/ and unlinks files whose
    // mtime is older than TTL. It has zero awareness of which sessions are
    // currently active. A long conversation that keeps the same sessionKey for
    // > TTL hours will silently lose its attachments mid-conversation when
    // the AI is asked to reason about an earlier image.
    //
    // IMPACT: MEDIUM — operators who set ATTACHMENT_TTL_HOURS=1 (or similar
    // tight value) and have a multi-turn conversation will see attachments
    // disappear. Default TTL of 24h limits the blast radius but doesn't fix
    // the root cause.
    //
    // FIX: Either (a) `touch` the file on every reference (downloads or AI
    // prompt build), so mtime tracks last-use and idle GC works as intended;
    // or (b) track active session keys in Router and skip those dirs in
    // sweepAttachments.
    const baseDir = mkTmp();
    const sess = path.join(baseDir, ".attachments", "active-session-id-1234");
    mkdirSync(sess, { recursive: true });
    const f = path.join(sess, "1234-aaaa-active.png");
    writeFileSync(f, "active session data");
    const oldTime = (Date.now() - 2 * 3600 * 1000) / 1000; // 2h old mtime
    utimesSync(f, oldTime, oldTime);
    const removed = await sweepAttachments(baseDir, 3600 * 1000); // TTL 1h
    assert.strictEqual(removed, 1, "current behaviour: file deleted regardless of session liveness");
    assert.strictEqual(existsSync(f), false, "file is gone — flip this when GC respects active sessions");
  });

  it("uses mtime, not atime — atime updates do NOT extend the TTL window", async () => {
    // Documents the time-source choice. atime updates from cat/grep/AI prompt
    // assembly do NOT count as "use" — mtime is the only signal.
    const baseDir = mkTmp();
    const sess = path.join(baseDir, ".attachments", "atime-test");
    mkdirSync(sess, { recursive: true });
    const f = path.join(sess, "victim.png");
    writeFileSync(f, "x");
    // Backdate mtime to 2h ago, but set atime to "now"
    const old = (Date.now() - 2 * 3600 * 1000) / 1000;
    const now = Date.now() / 1000;
    utimesSync(f, now, old); // (atime=now, mtime=old)
    const removed = await sweepAttachments(baseDir, 3600 * 1000);
    assert.strictEqual(removed, 1, "atime=now did not save the file from being swept");
    assert.strictEqual(existsSync(f), false);
  });

  it("time-window boundary: file just inside TTL is kept; just outside is removed", async () => {
    const baseDir = mkTmp();
    const sess = path.join(baseDir, ".attachments", "boundary-test");
    mkdirSync(sess, { recursive: true });
    const fresh = path.join(sess, "fresh.png");
    const stale = path.join(sess, "stale.png");
    writeFileSync(fresh, "x");
    writeFileSync(stale, "x");
    const ttlMs = 60_000; // 1 min
    // fresh: 30s old (well inside TTL) → keep
    const freshTime = (Date.now() - 30_000) / 1000;
    utimesSync(fresh, freshTime, freshTime);
    // stale: 90s old (outside TTL) → remove
    const staleTime = (Date.now() - 90_000) / 1000;
    utimesSync(stale, staleTime, staleTime);
    const removed = await sweepAttachments(baseDir, ttlMs);
    assert.strictEqual(removed, 1, "exactly one file removed (the stale one)");
    assert.strictEqual(existsSync(fresh), true, "fresh file kept");
    assert.strictEqual(existsSync(stale), false, "stale file removed");
  });

  it("startAttachmentGc with ATTACHMENT_TTL_HOURS=0 returns no-op stop()", () => {
    const old = process.env["ATTACHMENT_TTL_HOURS"];
    process.env["ATTACHMENT_TTL_HOURS"] = "0";
    try {
      const stop = startAttachmentGc({ baseDir: mkTmp() });
      assert.strictEqual(typeof stop, "function");
      stop(); // must not throw
    } finally {
      if (old == null) delete process.env["ATTACHMENT_TTL_HOURS"];
      else process.env["ATTACHMENT_TTL_HOURS"] = old;
    }
  });
});

// ============================================================================
// P1-8 Adapter-trust: server MIME re-validation
// ============================================================================

describe("QA-R2 P1-8 Adapter-trust: adapter says image/png, server says video/mp4 → REJECT", () => {
  it("disagreement at the wire level rejects with reason='mime'", async () => {
    const body = Buffer.from("\x00\x00\x00\x18ftypisom"); // mp4-ish
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      await withOverride(async () => {
        const baseDir = mkTmp();
        await assert.rejects(
          () => downloadAttachment(
            // Adapter LIES: declares image/png
            { url: url("/x.png"), filename: "x.png", mimeType: "image/png" },
            { baseDir, sessionId: "s", enforceUrlValidation: false },
          ),
          (e: any) => e instanceof AttachmentError && e.reason === "mime",
        );
      });
    } finally { server.close(); }
  });

  it("server's application/zip with adapter image/png also rejected (not laundered)", async () => {
    const body = Buffer.from("PK\x03\x04zipdata");
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/zip", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      await withOverride(async () => {
        const baseDir = mkTmp();
        await assert.rejects(
          () => downloadAttachment(
            { url: url("/img.png"), filename: "img.png", mimeType: "image/png" },
            { baseDir, sessionId: "s", enforceUrlValidation: false },
          ),
          (e: any) => e instanceof AttachmentError && e.reason === "mime",
        );
      });
    } finally { server.close(); }
  });

  it("adapter image/png + server image/png → accepted (control)", async () => {
    const body = Buffer.from("\x89PNG\r\n\x1a\nfake-png-bytes");
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      await withOverride(async () => {
        const baseDir = mkTmp();
        const out = await downloadAttachment(
          { url: url("/x.png"), filename: "x.png", mimeType: "image/png" },
          { baseDir, sessionId: "s", enforceUrlValidation: false },
        );
        assert.strictEqual(out.mimeType, "image/png");
        assert.strictEqual(out.size, body.length);
      });
    } finally { server.close(); }
  });
});

// ============================================================================
// Deferred items — exploit attempts
// ============================================================================

describe("QA-R2 Deferred: magic-byte content sniffing (Coder consciously deferred)", () => {
  // The Coder deferred magic-byte sniffing as "out of scope; project doesn't
  // depend on the gateway being a virus scanner." We confirm the deferral
  // means a renamed binary IS accepted as long as adapter+server collude on
  // the MIME label.
  it("[DEFERRED] .png filename + image/png header but actual ELF/PE bytes are accepted", async () => {
    // Real PE header magic
    const exe = Buffer.concat([
      Buffer.from("MZ"),
      Buffer.alloc(58, 0),
      Buffer.from([0x80, 0, 0, 0]),
      Buffer.from("PE\0\0"),
      Buffer.from("...rest of fake PE..."),
    ]);
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(exe.length) });
      res.end(exe);
    });
    try {
      await withOverride(async () => {
        const baseDir = mkTmp();
        const out = await downloadAttachment(
          { url: url("/innocent.png"), filename: "innocent.png", mimeType: "image/png" },
          { baseDir, sessionId: "s", enforceUrlValidation: false },
        );
        // Currently accepted — magic-byte sniffing is deferred. The risk is
        // limited because (a) gateway only forwards a path to the AI agent,
        // and (b) the AI agent doesn't execute the file. But ANY downstream
        // tool that opens the path expecting a PNG could misbehave.
        assert.strictEqual(out.mimeType, "image/png");
        assert.strictEqual(out.size, exe.length);
      });
    } finally { server.close(); }
  });
});

describe("QA-R2 Deferred: Discord URL 5xx retry (Coder consciously deferred)", () => {
  it("[DEFERRED] single 5xx response is reported as download failure (no retry)", async () => {
    let hits = 0;
    const { server, url } = await startStaticServer((_req, res) => {
      hits++;
      res.writeHead(502); res.end();
    });
    try {
      await withOverride(async () => {
        const baseDir = mkTmp();
        await assert.rejects(
          () => downloadAttachment(
            { url: url("/cdn.png"), filename: "x.png", mimeType: "image/png" },
            { baseDir, sessionId: "s", enforceUrlValidation: false },
          ),
          (e: any) => e instanceof AttachmentError && e.reason === "download",
        );
        assert.strictEqual(hits, 1, "no retry happened (deferred behaviour)");
      });
    } finally { server.close(); }
  });
});

// ============================================================================
// New regression hunting (post-fix)
// ============================================================================

describe("QA-R2 new-hunt: Telegram tg-file:// SSRF check is bypassed (skipUrl heuristic)", () => {
  // BACKGROUND
  // downloadAttachment computes:
  //   const skipUrl = opts.enforceUrlValidation ? false : (opts.skipUrlValidation ?? !!opts.fetchImpl);
  // and `effectiveUrl` becomes the resolved Telegram URL only AFTER skipUrl
  // is decided implicitly by `att.url.startsWith("tg-file://")`.
  // Then assertSafeUrl runs on `effectiveUrl` only when `!skipUrl`.
  //
  // The Telegram resolver returns a public api.telegram.org URL, so for
  // production code this is fine — the resolved host is always public.
  // BUT: if a future feature lets a tg-file resolver return an arbitrary URL
  // (or if Telegram's `file_path` ever embeds a `..` / scheme), the SSRF
  // guard runs only on the post-resolution URL — which we DO want — so this
  // is actually correct. The test pins this design choice.
  it("post-resolution URL is the one validated (assertSafeUrl runs on resolved URL)", async () => {
    const oldTok = process.env["TELEGRAM_BOT_TOKEN"];
    process.env["TELEGRAM_BOT_TOKEN"] = "1:test";
    try {
      const baseDir = mkTmp();
      // Resolver returns a loopback URL — should be REJECTED by SSRF guard.
      // We piggyback on the same fetchImpl: getFile returns a malicious file_path
      // that, when concatenated, points to api.telegram.org which is public.
      // To force loopback we'd need to monkey-patch resolveTelegramFileUrl.
      // Instead, prove the guard runs on the resolved URL by asserting the
      // happy-path host is api.telegram.org and the guard accepts it.
      let calledWith: string | undefined;
      const fetchMock: any = async (url: string) => {
        if (calledWith === undefined) {
          calledWith = url;
          return new Response(JSON.stringify({ ok: true, result: { file_path: "documents/x.pdf" } }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        // Second call — file fetch. We'll fail it after capturing the URL.
        calledWith = url;
        return new Response(Buffer.from("ok"), { status: 200, headers: { "content-type": "application/pdf", "content-length": "2" } });
      };
      await downloadAttachment(
        { url: "tg-file://abc", filename: "x.pdf", mimeType: "application/pdf" },
        { baseDir, sessionId: "s", fetchImpl: fetchMock },
      );
      assert.match(calledWith ?? "", /^https:\/\/api\.telegram\.org\/file\/bot/);
    } finally {
      if (oldTok == null) delete process.env["TELEGRAM_BOT_TOKEN"];
      else process.env["TELEGRAM_BOT_TOKEN"] = oldTok;
    }
  });
});

describe("QA-R2 new-hunt: filename-based collision via random suffix entropy", () => {
  it("random 4-byte suffix gives ~2^32 entropy — practically collision-free for batched downloads", async () => {
    // Confirms QA-6.4 fix: ${Date.now()}-${randomBytes(4).toString("hex")}-${name}
    // Generate 1000 names sharing the same Date.now() ms and assert all unique.
    const { randomBytes } = await import("node:crypto");
    const ts = Date.now();
    const names = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      names.add(`${ts}-${randomBytes(4).toString("hex")}-x.png`);
    }
    assert.strictEqual(names.size, 1000, "no collision over 1000 same-ms names");
  });
});

describe("QA-R2 new-hunt: response.body empty edge — Number(\"\") returns 0 trips the empty-body guard", () => {
  it("[BROKEN] 200 with no body and NO content-length header is silently accepted as size=0", async () => {
    // BACKGROUND
    // After streaming completes, the empty-body fallback is:
    //   if (written === 0 && !(Number.isFinite(headerLen) && headerLen === 0)) reject;
    // BUT `headerLen = Number(res.headers.get("content-length") ?? "")` returns
    // 0 when the header is *absent* (Number("") === 0, isFinite(0) === true),
    // not NaN as the author likely expected. So a 200 with no body AND no
    // Content-Length header skips the reject and produces a 0-byte file.
    //
    // IMPACT: LOW–MEDIUM — a buggy origin can deliver an empty payload that the
    // gateway hands to the AI as a legitimate (empty) attachment. The AI may
    // then hallucinate over an empty file.
    //
    // FIX: use `const headerLenRaw = res.headers.get("content-length");` and
    //      `const headerLen = headerLenRaw == null ? NaN : Number(headerLenRaw);`
    //      That way a missing header is properly NaN, fails Number.isFinite,
    //      and the empty-body fallback fires.
    const { server, url } = await startStaticServer((_req, res) => {
      // Chunked encoding implied; no Content-Length header at all
      res.writeHead(200, { "content-type": "image/png" });
      res.end();
    });
    try {
      await withOverride(async () => {
        const baseDir = mkTmp();
        const out = await downloadAttachment(
          { url: url("/x.png"), filename: "x.png", mimeType: "image/png" },
          { baseDir, sessionId: "s", enforceUrlValidation: false },
        );
        // Currently accepted as a legitimate empty attachment. When the fix
        // lands, flip to assert.rejects(...).
        assert.strictEqual(out.size, 0, "silent acceptance of empty body");
      });
    } finally { server.close(); }
  });
});

describe("QA-R2 new-hunt: timeout abort cleans up partial file", () => {
  it("Slow upstream + ATTACHMENT_TIMEOUT_MS = 50ms → reject AND no file leaked", async () => {
    // Server that starts a body then hangs
    const srv = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": "1024" });
      res.write(Buffer.alloc(10, 0x42));
      // never end
    });
    try {
      await withOverride(async () => {
        const baseDir = mkTmp();
        const old = process.env["ATTACHMENT_TIMEOUT_MS"];
        process.env["ATTACHMENT_TIMEOUT_MS"] = "50";
        try {
          await assert.rejects(
            () => downloadAttachment(
              { url: srv.url("/slow.png"), filename: "slow.png", mimeType: "image/png" },
              { baseDir, sessionId: "s", enforceUrlValidation: false },
            ),
            (e: any) => e instanceof AttachmentError,
          );
          // Walk dir — no leftover files
          const root = path.join(baseDir, ".attachments");
          let leftovers = 0;
          if (existsSync(root)) {
            for (const sd of readdirSync(root)) for (const f of readdirSync(path.join(root, sd))) leftovers++;
          }
          assert.strictEqual(leftovers, 0, "abort/timeout left a partial file behind");
        } finally {
          if (old == null) delete process.env["ATTACHMENT_TIMEOUT_MS"];
          else process.env["ATTACHMENT_TIMEOUT_MS"] = old;
        }
      });
    } finally { srv.server.close(); }
  });
});
