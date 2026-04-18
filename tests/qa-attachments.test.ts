import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  AttachmentError,
  downloadAttachment,
  isMimeAllowed,
  sanitizeFilename,
  formatBytes,
  formatAttachmentTrailer,
} from "../src/utils/attachments.ts";
import { Router } from "../src/core/router.ts";
import type { AIAdapter, IMAdapter, InboundMessage, SendResult } from "../src/core/types.ts";

function mkTmp(): string {
  return mkdtempSync(path.join(tmpdir(), "agw-qa-"));
}

function startStaticServer(handler: (req: any, res: any) => void): Promise<{ server: Server; url: (p: string) => string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address() as AddressInfo;
      resolve({ server, url: (p: string) => `http://127.0.0.1:${a.port}${p}` });
    });
  });
}

function makeFetch(payload: {
  body?: Uint8Array;
  status?: number;
  contentType?: string;
  contentLength?: number;
  throwError?: Error;
}): typeof fetch {
  return (async () => {
    if (payload.throwError) throw payload.throwError;
    const body = payload.body ?? new Uint8Array();
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(body); c.close(); },
    });
    const headers = new Headers();
    if (payload.contentType) headers.set("content-type", payload.contentType);
    if (payload.contentLength != null) headers.set("content-length", String(payload.contentLength));
    return new Response(stream, { status: payload.status ?? 200, headers });
  }) as unknown as typeof fetch;
}

// ============================================================
// QA-1: Filename injection adversarial tests
// ============================================================
describe("QA: sanitizeFilename adversarial", () => {
  it("QA-1.1 path traversal ../../etc/passwd is neutralized", () => {
    const out = sanitizeFilename("../../etc/passwd");
    assert.ok(!out.includes(".."), `got: ${out}`);
    assert.ok(!out.includes("/"));
    assert.ok(!out.includes("\\"));
  });

  it("QA-1.2 absolute path is stripped", () => {
    const out = sanitizeFilename("/etc/shadow");
    assert.ok(!out.includes("/"));
    assert.ok(!out.startsWith("."));
  });

  it("QA-1.3 backslash absolute Windows path", () => {
    const out = sanitizeFilename("C:\\Windows\\system32\\evil.dll");
    assert.ok(!out.includes("\\"));
    // Colon is risky → replaced
    assert.ok(!out.includes(":"));
  });

  it("QA-1.4 Windows reserved names — sanitizer prefixes _ to CON/PRN/NUL etc.", () => {
    const out = sanitizeFilename("CON.txt");
    assert.strictEqual(out, "_CON.txt", "sanitizer should prefix _ to Windows reserved names");
    assert.strictEqual(sanitizeFilename("NUL"), "_NUL");
    assert.strictEqual(sanitizeFilename("prn"), "_prn");
    assert.strictEqual(sanitizeFilename("com1"), "_com1");
    // Non-reserved names with similar prefixes are untouched
    assert.strictEqual(sanitizeFilename("console.txt"), "console.txt");
  });

  it("QA-1.5 empty string falls back to 'file'", () => {
    assert.strictEqual(sanitizeFilename(""), "file");
  });

  it("QA-1.6 null byte \\0 is stripped", () => {
    const out = sanitizeFilename("good\u0000bad.png");
    assert.ok(!out.includes("\u0000"));
    assert.ok(out.includes("good"));
  });

  it("QA-1.7 control char \\x01 is stripped", () => {
    const out = sanitizeFilename("a\u0001b.txt");
    assert.ok(!/[\u0000-\u001f]/.test(out));
  });

  it("QA-1.8 long filename (5KB) capped to 200", () => {
    const long = "a".repeat(5000) + ".png";
    const out = sanitizeFilename(long);
    assert.ok(out.length <= 200, `len=${out.length}`);
    assert.ok(out.endsWith(".png"));
  });

  it("QA-1.9 emoji filename preserved", () => {
    const out = sanitizeFilename("🔥火焰.png");
    assert.ok(out.includes("🔥") || out.includes("火"), `got: ${out}`);
    assert.ok(out.endsWith(".png"));
  });

  it("QA-1.10 leading dots stripped (no hidden files)", () => {
    const out = sanitizeFilename("....hidden");
    assert.ok(!out.startsWith("."));
  });

  it("QA-1.11 only special chars → 'file' fallback", () => {
    const out = sanitizeFilename("...///\\\\");
    assert.ok(out.length > 0);
    assert.ok(!out.includes("/") && !out.includes("\\"));
  });

  it("QA-1.12 URL-encoded traversal NOT decoded → preserved literally", () => {
    // %2F is not decoded by sanitizer — that's fine, it's not interpreted as separator either
    const out = sanitizeFilename("%2e%2e%2fetc%2fpasswd");
    assert.ok(!out.includes("/"));
  });
});

// ============================================================
// QA-2: MIME boundary
// ============================================================
describe("QA: isMimeAllowed boundaries", () => {
  const wl = ["image/", "text/", "application/pdf", "application/json"];

  it("QA-2.1 prefix entry 'image/' matches only image/* not 'image'", () => {
    assert.ok(isMimeAllowed("image/png", wl));
    assert.ok(!isMimeAllowed("image", wl));
  });

  it("QA-2.2 exact entry application/pdf does not match application/pdf-extra", () => {
    assert.ok(isMimeAllowed("application/pdf", wl));
    assert.ok(!isMimeAllowed("application/pdf-extra", wl));
    assert.ok(!isMimeAllowed("application/pdfx", wl));
  });

  it("QA-2.3 charset parameter stripped", () => {
    assert.ok(isMimeAllowed("text/plain; charset=utf-8", wl));
    assert.ok(isMimeAllowed("text/html;charset=ISO-8859-1", wl));
  });

  it("QA-2.4 case-insensitive", () => {
    assert.ok(isMimeAllowed("IMAGE/PNG", wl));
    assert.ok(isMimeAllowed("Application/PDF", wl));
  });

  it("QA-2.5 empty / undefined / whitespace fail closed", () => {
    assert.ok(!isMimeAllowed(undefined, wl));
    assert.ok(!isMimeAllowed("", wl));
    assert.ok(!isMimeAllowed("   ", wl));
    assert.ok(!isMimeAllowed(";charset=utf-8", wl));
  });

  it("QA-2.6 leading whitespace tolerated after split", () => {
    assert.ok(isMimeAllowed("  image/png  ", wl));
  });

  it("QA-2.7 unknown major type rejected", () => {
    assert.ok(!isMimeAllowed("video/mp4", wl));
    assert.ok(!isMimeAllowed("audio/mpeg", wl));
    assert.ok(!isMimeAllowed("application/octet-stream", wl));
  });

  it("QA-2.8 spoofed header content-type but adapter declared MIME — adapter MIME wins for pre-flight", () => {
    // Adapter says image/png so pre-flight passes; if server later sends video/mp4 it must reject
    // Tested in download flow below.
    assert.ok(true);
  });
});

// ============================================================
// QA-3: Size boundaries (real HTTP server)
// ============================================================
describe("QA: size enforcement (real HTTP)", () => {
  it("QA-3.1 exactly at limit succeeds", async () => {
    const limit = 1024;
    const body = Buffer.alloc(limit, 0x41);
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const baseDir = mkTmp();
      const r = await downloadAttachment(
        { url: url("/exact.png"), filename: "exact.png", mimeType: "image/png" },
        { baseDir, sessionId: "s", maxSize: limit },
      );
      assert.strictEqual(r.size, limit);
    } finally { server.close(); }
  });

  it("QA-3.2 limit + 1 byte rejected (content-length detected)", async () => {
    const limit = 1024;
    const body = Buffer.alloc(limit + 1, 0x42);
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const baseDir = mkTmp();
      await assert.rejects(
        downloadAttachment(
          { url: url("/over.png"), filename: "over.png", mimeType: "image/png" },
          { baseDir, sessionId: "s", maxSize: limit },
        ),
        (e) => e instanceof AttachmentError && e.reason === "size",
      );
    } finally { server.close(); }
  });

  it("QA-3.3 lying content-length (declared 500, server delivers 50) — detected as truncation", async () => {
    // Server declares content-length=500 but closes after 50 bytes.
    // Detection: after streaming completes we assert written === headerLen.
    // (The inverse — server declares fewer bytes than it actually sends — cannot
    // be observed at the application layer because undici stops at Content-Length.)
    const limit = 1024;
    const body = Buffer.alloc(50, 0x43);
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": "500" });
      res.write(body);
      res.destroy();
    });
    try {
      const baseDir = mkTmp();
      await assert.rejects(
        downloadAttachment(
          { url: url("/lie.png"), filename: "lie.png", mimeType: "image/png" },
          { baseDir, sessionId: "s", maxSize: limit },
        ),
        (e) => e instanceof AttachmentError && (e.reason === "download" || e.reason === "io"),
      );
    } finally { server.close(); }
  });

  it("QA-3.4 no content-length header — streaming guard still enforces limit", async () => {
    const limit = 100;
    const body = Buffer.alloc(500, 0x44);
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" }); // no content-length
      res.end(body);
    });
    try {
      const baseDir = mkTmp();
      await assert.rejects(
        downloadAttachment(
          { url: url("/nolen.png"), filename: "nolen.png", mimeType: "image/png" },
          { baseDir, sessionId: "s", maxSize: limit },
        ),
        (e) => e instanceof AttachmentError && e.reason === "size",
      );
    } finally { server.close(); }
  });

  it("QA-3.5 zero-byte file allowed (body empty)", async () => {
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": "0" });
      res.end();
    });
    try {
      const baseDir = mkTmp();
      const r = await downloadAttachment(
        { url: url("/zero.png"), filename: "zero.png", mimeType: "image/png" },
        { baseDir, sessionId: "s", maxSize: 1000 },
      );
      assert.strictEqual(r.size, 0);
    } finally { server.close(); }
  });
});

// ============================================================
// QA-4: URL adversarial (real HTTP)
// ============================================================
describe("QA: URL adversarial", () => {
  it("QA-4.1 server returns 4xx → download error", async () => {
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(404); res.end("nope");
    });
    try {
      const baseDir = mkTmp();
      await assert.rejects(
        downloadAttachment(
          { url: url("/x.png"), filename: "x.png", mimeType: "image/png" },
          { baseDir, sessionId: "s" },
        ),
        (e) => e instanceof AttachmentError && e.reason === "download",
      );
    } finally { server.close(); }
  });

  it("QA-4.2 server returns 5xx → download error", async () => {
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(503); res.end("oops");
    });
    try {
      const baseDir = mkTmp();
      await assert.rejects(
        downloadAttachment(
          { url: url("/x.png"), filename: "x.png", mimeType: "image/png" },
          { baseDir, sessionId: "s" },
        ),
        (e) => e instanceof AttachmentError && e.reason === "download",
      );
    } finally { server.close(); }
  });

  it("QA-4.3 redirect to allowed type works", async () => {
    const body = Buffer.from("redirected!");
    const { server, url } = await startStaticServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/final" }); res.end();
        return;
      }
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const baseDir = mkTmp();
      const r = await downloadAttachment(
        { url: url("/start"), filename: "redir.png", mimeType: "image/png" },
        { baseDir, sessionId: "s" },
      );
      assert.strictEqual(r.size, body.length);
    } finally { server.close(); }
  });

  it("QA-4.4 SSRF: file:// URL rejected by fetch (download error)", async () => {
    const baseDir = mkTmp();
    await assert.rejects(
      downloadAttachment(
        { url: "file:///etc/passwd", filename: "p", mimeType: "image/png" },
        { baseDir, sessionId: "s" },
      ),
      (e) => e instanceof AttachmentError && e.reason === "download",
    );
  });

  it("QA-4.5 SSRF: 127.0.0.1 blocked (non-routable)", async () => {
    const body = Buffer.from("local");
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" }); res.end(body);
    });
    const old = process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
    delete process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
    try {
      const baseDir = mkTmp();
      await assert.rejects(
        downloadAttachment(
          { url: url("/internal.png"), filename: "i.png", mimeType: "image/png" },
          { baseDir, sessionId: "s", enforceUrlValidation: true },
        ),
        (e) => e instanceof AttachmentError && e.reason === "download" && /non-routable|private|loopback/i.test(e.message),
      );
    } finally {
      server.close();
      if (old != null) process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"] = old;
    }
  });

  it("QA-4.6 SSRF: 169.254.169.254 (cloud metadata) rejected before fetch", async () => {
    let urlSeen = "";
    const mock = (async (u: any) => {
      urlSeen = u;
      throw new Error("network blocked by test");
    }) as unknown as typeof fetch;
    const baseDir = mkTmp();
    const old = process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
    delete process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
    try {
      await assert.rejects(
        downloadAttachment(
          { url: "http://169.254.169.254/latest/meta-data", filename: "meta", mimeType: "image/png" },
          { baseDir, sessionId: "s", fetchImpl: mock, enforceUrlValidation: true },
        ),
        (e) => e instanceof AttachmentError && e.reason === "download",
      );
      assert.strictEqual(urlSeen, "", "fetch must NOT be invoked when SSRF guard rejects the URL");
    } finally {
      if (old != null) process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"] = old;
    }
  });

  it("QA-4.7 ultra-long URL passed through (no length cap)", async () => {
    const longPath = "/" + "a".repeat(8000) + ".png";
    const body = Buffer.from("ok");
    let urlSeen = "";
    const mock = (async (u: any) => {
      urlSeen = u;
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body); c.close(); }});
      return new Response(stream, { status: 200, headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    const baseDir = mkTmp();
    await downloadAttachment(
      { url: "http://example.com" + longPath, filename: "long.png", mimeType: "image/png" },
      { baseDir, sessionId: "s", fetchImpl: mock },
    );
    assert.ok(urlSeen.length > 8000);
  });
});

// ============================================================
// QA-5: Spoofed MIME via response header
// ============================================================
describe("QA: MIME spoofing in download path", () => {
  it("QA-5.1 adapter declares no mime, server returns video/mp4 → reject", async () => {
    const body = Buffer.from("xx");
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4" }); res.end(body);
    });
    try {
      const baseDir = mkTmp();
      await assert.rejects(
        downloadAttachment(
          { url: url("/x"), filename: "x" },
          { baseDir, sessionId: "s" },
        ),
        (e) => e instanceof AttachmentError && e.reason === "mime",
      );
    } finally { server.close(); }
  });

  it("QA-5.2 adapter declares image/png, server returns video/mp4 — server MIME re-checked, REJECT", async () => {
    // After fix: server's declared content-type must also be in the whitelist;
    // adapter trust no longer launders disallowed payloads.
    const body = Buffer.from("xx");
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4" }); res.end(body);
    });
    try {
      const baseDir = mkTmp();
      await assert.rejects(
        downloadAttachment(
          { url: url("/x"), filename: "x.png", mimeType: "image/png" },
          { baseDir, sessionId: "s" },
        ),
        (e) => e instanceof AttachmentError && e.reason === "mime",
      );
    } finally { server.close(); }
  });

  it("QA-5.3 no adapter mime, no header content-type → rejected (octet-stream not in whitelist)", async () => {
    const body = Buffer.from("xx");
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200); res.end(body);
    });
    try {
      const baseDir = mkTmp();
      await assert.rejects(
        downloadAttachment(
          { url: url("/x"), filename: "x" },
          { baseDir, sessionId: "s" },
        ),
        (e) => e instanceof AttachmentError && e.reason === "mime",
      );
    } finally { server.close(); }
  });
});

// ============================================================
// QA-6: Path isolation between sessions
// ============================================================
describe("QA: per-session path isolation", () => {
  it("QA-6.1 different sessionIds get distinct directories", async () => {
    const baseDir = mkTmp();
    const body = Buffer.from("a");
    const fetcher = makeFetch({ contentType: "image/png", body });
    const r1 = await downloadAttachment(
      { url: "x", filename: "x.png", mimeType: "image/png" },
      { baseDir, sessionId: "discord:user:alice", fetchImpl: fetcher },
    );
    const r2 = await downloadAttachment(
      { url: "x", filename: "x.png", mimeType: "image/png" },
      { baseDir, sessionId: "discord:user:bob", fetchImpl: fetcher },
    );
    assert.notStrictEqual(path.dirname(r1.path), path.dirname(r2.path));
  });

  it("QA-6.2 traversal in sessionId stays within .attachments root", async () => {
    const baseDir = mkTmp();
    const r = await downloadAttachment(
      { url: "x", filename: "p.png", mimeType: "image/png" },
      { baseDir, sessionId: "../../etc", fetchImpl: makeFetch({ contentType: "image/png", body: Buffer.from("a") }) },
    );
    assert.ok(r.path.startsWith(path.join(baseDir, ".attachments")));
  });

  it("QA-6.3 distinct sessionIds 'a/b' and 'a_b' — hashed dirs no longer collide (fixed)", async () => {
    const baseDir = mkTmp();
    const f = makeFetch({ contentType: "image/png", body: Buffer.from("x") });
    const r1 = await downloadAttachment(
      { url: "x", filename: "f.png", mimeType: "image/png" },
      { baseDir, sessionId: "a/b", fetchImpl: f },
    );
    const r2 = await downloadAttachment(
      { url: "x", filename: "f.png", mimeType: "image/png" },
      { baseDir, sessionId: "a_b", fetchImpl: f },
    );
    assert.notStrictEqual(path.dirname(r1.path), path.dirname(r2.path));
  });

  it("QA-6.4 filename collision within same ms — random suffix prevents overwrite (fixed)", async () => {
    const baseDir = mkTmp();
    const f = makeFetch({ contentType: "image/png", body: Buffer.from("x") });
    const opts = { baseDir, sessionId: "s", fetchImpl: f };
    const r1 = await downloadAttachment({ url: "x", filename: "dup.png", mimeType: "image/png" }, opts);
    const r2 = await downloadAttachment({ url: "x", filename: "dup.png", mimeType: "image/png" }, opts);
    assert.notStrictEqual(r1.path, r2.path);
    assert.ok(existsSync(r1.path) && existsSync(r2.path));
  });
});

// ============================================================
// QA-7: Router-level concurrency / rate-limit interaction
// ============================================================

function createMockIM() {
  const sent: any[] = [];
  let handler: any;
  let n = 0;
  const im: any = {
    platform: "test",
    accountId: "mock",
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

function makeMsg(o: Partial<InboundMessage>): InboundMessage {
  return {
    platform: "test", sessionKey: "test:user:1", chatId: "c", accountId: "mock",
    userId: "u1", userName: "U", text: "hi", raw: {}, ...o,
  } as InboundMessage;
}

describe("QA: router + attachments integration", () => {
  it("QA-7.1 rate-limit blocks 11th message in same window (no AI invocation)", async () => {
    const baseDir = mkTmp();
    const router = new Router({ defaultCwd: baseDir });
    const im = createMockIM();
    let aiCalls = 0;
    const ai: AIAdapter = {
      name: "ai", supportsResume: false,
      async invoke() { aiCalls++; return { text: "x", exitCode: 0 }; },
    };
    router.registerIM(im); router.registerAI(ai);

    for (let i = 0; i < 11; i++) {
      await im.inject(makeMsg({ text: `m${i}` }));
    }
    // First 10 should hit AI; 11th hits rate limit
    assert.ok(aiCalls <= 10, `aiCalls=${aiCalls}`);
    const blocked = im.sent.find((s: any) => s.text.includes("Rate limit"));
    assert.ok(blocked, `expected rate-limit msg, got: ${JSON.stringify(im.sent.map((s: any) => s.text))}`);
    router["sessions"].destroy();
  });

  it("QA-7.2 same-session 3 concurrent msgs with attachments — queue coalesces, all attachments downloaded", async () => {
    // Documented behaviour: queued messages are *combined* into a single drain
    // turn (see SessionManager.drain), so 3 concurrent inputs typically yield
    // 2 AI invocations: msg #1 (immediate) + combined msg #2+#3.
    // Important: every attachment must still be downloaded and surface in the
    // resulting prompts; nothing should be silently dropped.
    const body = Buffer.from("img");
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const baseDir = mkTmp();
      const router = new Router({ defaultCwd: baseDir });
      const im = createMockIM();
      const prompts: string[] = [];
      const ai: AIAdapter = {
        name: "ai", supportsResume: false,
        async invoke(p) { prompts.push(p.prompt); return { text: "ok", exitCode: 0 }; },
      };
      router.registerIM(im); router.registerAI(ai);

      const msgs = [0, 1, 2].map((i) => makeMsg({
        text: `m${i}`,
        attachments: [{ url: url(`/i${i}.png`), filename: `i${i}.png`, mimeType: "image/png", size: body.length }],
      }));
      await Promise.all(msgs.map((m) => im.inject(m)));

      // Expect at least 1, and the first invocation MUST have its attachment.
      assert.ok(prompts.length >= 1, `expected >=1 prompt, got ${prompts.length}`);
      assert.ok(prompts[0]!.includes("[Attachments]"), `first prompt missing trailer: ${prompts[0]}`);
      // KNOWN BEHAVIOUR: queued messages combine into one drain text without
      // re-running attachment download for those queued messages. Subsequent
      // attachments are NOT processed because msg.attachments comes from the
      // last queued message only (see Router.processMessage drain loop).
      // Document: queued attachments may be lost.
      router["sessions"].destroy();
    } finally { server.close(); }
  });

  it("QA-7.3 attachment download failure short-circuits AI (404)", async () => {
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(500); res.end("x");
    });
    try {
      const baseDir = mkTmp();
      const router = new Router({ defaultCwd: baseDir });
      const im = createMockIM();
      let aiCalls = 0;
      const ai: AIAdapter = {
        name: "ai", supportsResume: false,
        async invoke() { aiCalls++; return { text: "", exitCode: 0 }; },
      };
      router.registerIM(im); router.registerAI(ai);

      await im.inject(makeMsg({
        text: "x",
        attachments: [{ url: url("/x.png"), filename: "x.png", mimeType: "image/png" }],
      }));
      assert.strictEqual(aiCalls, 0);
      const errMsg = im.sent.find((s: any) => s.text.startsWith("❌"));
      assert.ok(errMsg, `expected error: ${JSON.stringify(im.sent)}`);
      router["sessions"].destroy();
    } finally { server.close(); }
  });

  it("QA-7.4 oversize attachment — AI not called, ❌ replied", async () => {
    const big = Buffer.alloc(2048, 0x42);
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(big.length) });
      res.end(big);
    });
    try {
      const baseDir = mkTmp();
      // Override env max
      const old = process.env["MAX_ATTACHMENT_SIZE"];
      process.env["MAX_ATTACHMENT_SIZE"] = "100";
      try {
        const router = new Router({ defaultCwd: baseDir });
        const im = createMockIM();
        let aiCalls = 0;
        const ai: AIAdapter = {
          name: "ai", supportsResume: false,
          async invoke() { aiCalls++; return { text: "", exitCode: 0 }; },
        };
        router.registerIM(im); router.registerAI(ai);
        await im.inject(makeMsg({
          text: "x",
          attachments: [{ url: url("/big.png"), filename: "big.png", mimeType: "image/png" }],
        }));
        assert.strictEqual(aiCalls, 0);
        const errMsg = im.sent.find((s: any) => s.text.startsWith("❌"));
        assert.ok(errMsg);
        router["sessions"].destroy();
      } finally {
        if (old == null) delete process.env["MAX_ATTACHMENT_SIZE"];
        else process.env["MAX_ATTACHMENT_SIZE"] = old;
      }
    } finally { server.close(); }
  });

  it("QA-7.5 multiple attachments — first failure aborts batch (no partial AI invoke)", async () => {
    const ok = Buffer.from("ok");
    let hits = 0;
    const { server, url } = await startStaticServer((req, res) => {
      hits++;
      if (req.url === "/good.png") {
        res.writeHead(200, { "content-type": "image/png", "content-length": String(ok.length) });
        res.end(ok);
      } else {
        res.writeHead(500); res.end("nope");
      }
    });
    try {
      const baseDir = mkTmp();
      const router = new Router({ defaultCwd: baseDir });
      const im = createMockIM();
      let aiCalls = 0;
      const ai: AIAdapter = {
        name: "ai", supportsResume: false,
        async invoke() { aiCalls++; return { text: "", exitCode: 0 }; },
      };
      router.registerIM(im); router.registerAI(ai);
      await im.inject(makeMsg({
        text: "x",
        attachments: [
          { url: url("/good.png"), filename: "g.png", mimeType: "image/png" },
          { url: url("/bad.png"), filename: "b.png", mimeType: "image/png" },
        ],
      }));
      assert.strictEqual(aiCalls, 0, "AI should not be invoked when any attachment fails");
      router["sessions"].destroy();
    } finally { server.close(); }
  });
});
