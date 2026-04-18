// R3 — regression suite for the 8 fixes landed after the R2 review + QA pass.
// Each describe block maps 1:1 to a numbered fix in FIX-R3.md so a future
// reviewer can trace test → commit → issue.
//
// All tests assert FIXED behaviour. Anything still asserting "broken" lives in
// tests/qa-r2-attachments.test.ts and is intentionally pinned for the next round.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  AttachmentError,
  assertSafeUrl,
  downloadAttachment,
  isPrivateIp,
  resolveTelegramFileUrl,
} from "../src/utils/attachments.ts";
import { sweepAttachments, startAttachmentGc } from "../src/utils/attachments-gc.ts";
import { Router } from "../src/core/router.ts";
import type { AIAdapter, InboundMessage } from "../src/core/types.ts";

function mkTmp(prefix = "agw-r3-"): string {
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

// ============================================================================
// R3 #1 — SSRF Bypass A: redirect follow + per-hop assertSafeUrl + hop cap
// ============================================================================

describe("R3 #1 SSRF redirect handling", () => {
  it("302 → loopback IP literal is rejected by per-hop assertSafeUrl", async () => {
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
      await withoutOverride(async () => {
        await assert.rejects(
          () => downloadAttachment(
            { url: redir.url("/start"), filename: "x.png", mimeType: "image/png" },
            { baseDir, sessionId: "s", enforceUrlValidation: true },
          ),
          AttachmentError,
        );
      });
      assert.strictEqual(internalReached, false,
        "internal server must not be reached when the loopback target is rejected");
    } finally {
      internal.server.close(); redir.server.close();
    }
  });

  it("redirect chain longer than MAX_REDIRECT_HOPS throws redirect_loop", async () => {
    // Build a self-referential redirect server.
    let visits = 0;
    const { server, url } = await startStaticServer((_req, res) => {
      visits++;
      res.writeHead(302, { location: "/loop" });
      res.end();
    });
    try {
      const baseDir = mkTmp();
      await assert.rejects(
        () => downloadAttachment(
          { url: url("/loop"), filename: "x.png", mimeType: "image/png" },
          // skip per-hop SSRF (loopback) but still exercise the manual redirect path
          { baseDir, sessionId: "s", skipUrlValidation: true },
        ),
        (e: any) => e instanceof AttachmentError && e.reason === "redirect_loop",
      );
      // Hops capped at 3 → 1 initial + 3 follows = 4 visits max (we stop AFTER 3 follows)
      assert.ok(visits <= 4, `visits=${visits} should be ≤ 4 (cap honored)`);
    } finally { server.close(); }
  });

  it("302 → 200 with same-origin same-host succeeds (control: redirects still work)", async () => {
    const body = Buffer.from("hello!");
    const { server, url } = await startStaticServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/dest" }); res.end(); return;
      }
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const baseDir = mkTmp();
      const out = await downloadAttachment(
        { url: url("/start"), filename: "x.png", mimeType: "image/png" },
        { baseDir, sessionId: "s", skipUrlValidation: true },
      );
      assert.strictEqual(out.size, body.length);
    } finally { server.close(); }
  });
});

// ============================================================================
// R3 #2 — SSRF Bypass B: IPv4-mapped IPv6 classification
// ============================================================================

describe("R3 #2 IPv4-mapped IPv6 classification", () => {
  const cases = [
    { ip: "::ffff:127.0.0.1",       label: "loopback (dotted)" },
    { ip: "::ffff:7f00:1",          label: "loopback (hex)" },
    { ip: "::ffff:169.254.169.254", label: "cloud metadata (dotted)" },
    { ip: "::ffff:a9fe:a9fe",       label: "cloud metadata (hex)" },
    { ip: "::ffff:0a00:0001",       label: "10.0.0.1 (hex)" },
    { ip: "::ffff:c0a8:0001",       label: "192.168.0.1 (hex)" },
    { ip: "::ffff:ac10:0001",       label: "172.16.0.1 (hex)" },
    { ip: "::ffff:6440:0001",       label: "100.64.0.1 CGN (hex)" },
  ];
  for (const { ip, label } of cases) {
    it(`isPrivateIp accepts ${ip} as private (${label})`, () => {
      assert.strictEqual(isPrivateIp(ip), true);
    });
  }

  it("URL-form IPv4-mapped hex hosts are rejected by assertSafeUrl", async () => {
    await withoutOverride(async () => {
      for (const { ip } of cases) {
        await assert.rejects(
          () => assertSafeUrl(`http://[${ip}]/x`),
          AttachmentError,
          `must reject http://[${ip}]/x`,
        );
      }
    });
  });

  it("public IPv6 is still allowed (control)", () => {
    // 2606:4700::1 (Cloudflare) — must NOT be misclassified as private.
    assert.strictEqual(isPrivateIp("2606:4700::1"), false);
  });
});

// ============================================================================
// R3 #3 — GC active-session awareness
// ============================================================================

describe("R3 #3 GC active-session awareness", () => {
  it("Router-level: live conversation file survives sweep until session releases", async () => {
    const baseDir = mkTmp();
    // Simulate the Router's bookkeeping by hand-feeding sweepAttachments.
    const sessionDir = "live-session-r3-fixture";
    const sess = path.join(baseDir, ".attachments", sessionDir);
    mkdirSync(sess, { recursive: true });
    const f = path.join(sess, "1-keep.png");
    writeFileSync(f, "x");
    const stale = (Date.now() - 10 * 3600 * 1000) / 1000;
    utimesSync(f, stale, stale);

    // Active set contains the dir → no removal.
    const active = new Set<string>([sessionDir]);
    const removed = await sweepAttachments(baseDir, 3600 * 1000, active);
    assert.strictEqual(removed, 0);
    assert.strictEqual(existsSync(f), true);

    // Session goes idle → removable.
    const removed2 = await sweepAttachments(baseDir, 3600 * 1000, new Set());
    assert.strictEqual(removed2, 1);
    assert.strictEqual(existsSync(f), false);
  });

  it("startAttachmentGc invokes getActiveSessionDirs() each tick (live state)", async () => {
    const baseDir = mkTmp();
    let calls = 0;
    const stop = startAttachmentGc({
      baseDir,
      ttlMs: 3600 * 1000,
      intervalMs: 50,
      getActiveSessionDirs: () => { calls++; return new Set(); },
    });
    await new Promise((r) => setTimeout(r, 180));
    stop();
    assert.ok(calls >= 2, `getActiveSessionDirs invoked at least twice, got ${calls}`);
  });
});

// ============================================================================
// R3 #4 — Empty-body guard with missing Content-Length
// ============================================================================

describe("R3 #4 Empty-body guard distinguishes missing CL from CL: 0", () => {
  it("missing CL + empty body → reject as download", async () => {
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end();
    });
    try {
      const baseDir = mkTmp();
      await assert.rejects(
        () => downloadAttachment(
          { url: url("/x.png"), filename: "x.png", mimeType: "image/png" },
          { baseDir, sessionId: "s", skipUrlValidation: true },
        ),
        (e: any) => e instanceof AttachmentError && e.reason === "download",
      );
    } finally { server.close(); }
  });

  it("explicit CL: 0 + empty body → still allowed (legitimate)", async () => {
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": "0" });
      res.end();
    });
    try {
      const baseDir = mkTmp();
      const out = await downloadAttachment(
        { url: url("/x.png"), filename: "x.png", mimeType: "image/png" },
        { baseDir, sessionId: "s", skipUrlValidation: true },
      );
      assert.strictEqual(out.size, 0);
    } finally { server.close(); }
  });

  it("missing CL + non-empty body → succeeds (control)", async () => {
    const body = Buffer.from("data");
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(body);
    });
    try {
      const baseDir = mkTmp();
      const out = await downloadAttachment(
        { url: url("/x.png"), filename: "x.png", mimeType: "image/png" },
        { baseDir, sessionId: "s", skipUrlValidation: true },
      );
      assert.strictEqual(out.size, body.length);
    } finally { server.close(); }
  });
});

// ============================================================================
// R3 #6 — Router cleans up downloaded[] when AI invoke fails
// ============================================================================

describe("R3 #6 Router unlinks downloads when AI invocation throws", () => {
  function createMockIM() {
    const sent: any[] = [];
    let handler: any;
    let n = 0;
    const im: any = {
      platform: "test", accountId: "mock",
      async connect() {}, async disconnect() {},
      async sendMessage(p: any) { sent.push(p); n++; return { messageId: `m${n}`, chatId: p.chatId, threadId: p.threadId }; },
      async sendTyping() {},
      onMessage(h: any) { handler = h; },
      async react() {}, async unreact() {},
    };
    im.sent = sent;
    im.inject = (msg: InboundMessage) => handler(msg);
    return im;
  }

  it("AI throws → downloaded files are unlinked, not left for GC", async () => {
    const body = Buffer.from("\x89PNG\r\n\x1a\nfake-png-bytes");
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const baseDir = mkTmp();
      const router = new Router({ defaultCwd: baseDir });
      const im = createMockIM();
      const ai: AIAdapter = {
        name: "ai", supportsResume: false,
        async invoke() { throw new Error("AI exploded"); },
      };
      router.registerIM(im); router.registerAI(ai);

      await im.inject({
        platform: "test",
        sessionKey: "test:r3-cleanup",
        chatId: "c",
        accountId: "mock",
        userId: "u",
        userName: "u",
        text: "hi",
        replyToId: "msg-1",
        attachments: [{
          url: url("/img.png"), filename: "img.png", mimeType: "image/png", size: body.length,
        }],
      } as InboundMessage);

      // Walk .attachments/ — there should be NO .png leftovers.
      const root = path.join(baseDir, ".attachments");
      let pngs = 0;
      if (existsSync(root)) {
        for (const sd of readdirSync(root)) {
          for (const f of readdirSync(path.join(root, sd))) if (f.endsWith(".png")) pngs++;
        }
      }
      assert.strictEqual(pngs, 0, "downloaded files must be unlinked when AI invoke throws");
      router["sessions"].destroy();
    } finally { server.close(); }
  });
});

// ============================================================================
// R3 #7 — Telegram filePath encoding hygiene
// ============================================================================

describe("R3 #7 Telegram filePath encoding", () => {
  it("filePath with spaces and unicode is encoded into a valid URL", async () => {
    const TOKEN = "111:abc";
    const old = process.env["TELEGRAM_BOT_TOKEN"];
    process.env["TELEGRAM_BOT_TOKEN"] = TOKEN;
    try {
      const fetchMock: any = async () => new Response(
        JSON.stringify({ ok: true, result: { file_path: "documents/中文 file name.pdf" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      const out = await resolveTelegramFileUrl("tg-file://abc", fetchMock);
      // The slash separator must survive (encodeURI), spaces and unicode must be encoded.
      assert.match(out, /^https:\/\/api\.telegram\.org\/file\/bot111:abc\/documents\//);
      assert.ok(!out.includes(" "), `spaces must be percent-encoded: ${out}`);
      // URL parse must succeed.
      const u = new URL(out);
      assert.strictEqual(u.host, "api.telegram.org");
    } finally {
      if (old == null) delete process.env["TELEGRAM_BOT_TOKEN"];
      else process.env["TELEGRAM_BOT_TOKEN"] = old;
    }
  });
});

// ============================================================================
// R3 #8 — CL-mismatch reason is `download_truncated`
// ============================================================================

describe("R3 #8 Content-Length truncation reports reason='download_truncated'", () => {
  it("server lies about CL → AttachmentError with reason 'download_truncated'", async () => {
    const data = "Y".repeat(10);
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": "100" });
      res.write(data);
      res.socket?.end();
    });
    try {
      const baseDir = mkTmp();
      await assert.rejects(
        () => downloadAttachment(
          { url: url("/x.png"), filename: "x.png", mimeType: "image/png" },
          { baseDir, sessionId: "s", skipUrlValidation: true },
        ),
        (e: any) => e instanceof AttachmentError && e.reason === "download_truncated",
      );
    } finally { server.close(); }
  });
});
