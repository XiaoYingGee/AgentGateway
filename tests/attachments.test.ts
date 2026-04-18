import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  AttachmentError,
  downloadAttachment,
  formatAttachmentTrailer,
  formatBytes,
  isMimeAllowed,
  sanitizeFilename,
} from "../src/utils/attachments.ts";

function mkTmp(): string {
  return mkdtempSync(path.join(tmpdir(), "agw-att-"));
}

function makeFetch(payload: {
  body?: Uint8Array;
  status?: number;
  contentType?: string;
  contentLength?: number;
  throwError?: Error;
}): typeof fetch {
  return (async (_url: any, _init: any) => {
    if (payload.throwError) throw payload.throwError;
    const body = payload.body ?? new Uint8Array();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
    const headers = new Headers();
    if (payload.contentType) headers.set("content-type", payload.contentType);
    if (payload.contentLength != null) headers.set("content-length", String(payload.contentLength));
    return new Response(stream, { status: payload.status ?? 200, headers });
  }) as unknown as typeof fetch;
}

describe("sanitizeFilename", () => {
  it("strips path separators and parent refs", () => {
    const a = sanitizeFilename("../../etc/passwd");
    assert.ok(!a.includes(".."), `expected no parent refs, got ${a}`);
    assert.ok(!a.includes("/") && !a.includes("\\"));
    assert.ok(a.endsWith("etc_passwd"));
    assert.strictEqual(sanitizeFilename("foo/bar.png"), "foo_bar.png");
    assert.strictEqual(sanitizeFilename("a\\b\\c.txt"), "a_b_c.txt");
  });

  it("replaces control + risky chars", () => {
    assert.strictEqual(sanitizeFilename("a:b|c?.txt"), "a_b_c_.txt");
  });

  it("falls back to non-empty safe name for empty/dot-only input", () => {
    assert.strictEqual(sanitizeFilename(""), "file");
    const out = sanitizeFilename("...");
    assert.ok(out.length > 0);
    assert.ok(!out.includes(".."));
  });

  it("caps length at 200 chars", () => {
    const long = "a".repeat(500) + ".png";
    const out = sanitizeFilename(long);
    assert.ok(out.length <= 200);
    assert.ok(out.endsWith(".png"));
  });
});

describe("isMimeAllowed", () => {
  const wl = ["image/", "text/", "application/pdf", "application/json"];

  it("allows prefix matches", () => {
    assert.ok(isMimeAllowed("image/png", wl));
    assert.ok(isMimeAllowed("image/jpeg", wl));
    assert.ok(isMimeAllowed("text/plain", wl));
  });

  it("allows exact matches", () => {
    assert.ok(isMimeAllowed("application/pdf", wl));
    assert.ok(isMimeAllowed("application/json", wl));
  });

  it("rejects non-listed types", () => {
    assert.ok(!isMimeAllowed("application/zip", wl));
    assert.ok(!isMimeAllowed("video/mp4", wl));
  });

  it("fails closed for empty/undefined", () => {
    assert.ok(!isMimeAllowed(undefined, wl));
    assert.ok(!isMimeAllowed("", wl));
  });

  it("normalizes case + parameters", () => {
    assert.ok(isMimeAllowed("IMAGE/PNG", wl));
    assert.ok(isMimeAllowed("text/plain; charset=utf-8", wl));
  });
});

describe("formatBytes", () => {
  it("formats bytes / KB / MB", () => {
    assert.strictEqual(formatBytes(512), "512B");
    assert.strictEqual(formatBytes(2048), "2.0KB");
    assert.match(formatBytes(2 * 1024 * 1024), /MB$/);
  });
});

describe("formatAttachmentTrailer", () => {
  it("returns empty string when no downloads", () => {
    assert.strictEqual(formatAttachmentTrailer([]), "");
  });

  it("formats trailer with paths and metadata", () => {
    const out = formatAttachmentTrailer([
      { path: "/tmp/x/a.png", filename: "a.png", mimeType: "image/png", size: 1024 },
      { path: "/tmp/x/b.txt", filename: "b.txt", mimeType: "text/plain", size: 50 },
    ]);
    assert.ok(out.startsWith("\n\n[Attachments]\n"));
    assert.ok(out.includes("/tmp/x/a.png (image/png, 1.0KB)"));
    assert.ok(out.includes("/tmp/x/b.txt (text/plain, 50B)"));
  });
});

describe("downloadAttachment", () => {
  it("downloads a small image into per-session dir", async () => {
    const baseDir = mkTmp();
    const body = new Uint8Array(Buffer.from("hello-world"));
    const result = await downloadAttachment(
      { url: "https://example/img.png", filename: "img.png", mimeType: "image/png", size: body.length },
      {
        baseDir,
        sessionId: "discord:guild:G:channel:C:user:U",
        fetchImpl: makeFetch({ body, contentType: "image/png" }),
      },
    );
    assert.ok(existsSync(result.path));
    assert.strictEqual(readFileSync(result.path).toString(), "hello-world");
    assert.strictEqual(result.mimeType, "image/png");
    assert.strictEqual(result.size, body.length);
    // Path lives under .attachments/<sanitizedSession>/
    assert.ok(result.path.includes(path.join(baseDir, ".attachments")));
  });

  it("rejects oversize from declared attachment metadata", async () => {
    const baseDir = mkTmp();
    await assert.rejects(
      downloadAttachment(
        { url: "x", filename: "big.bin", mimeType: "image/png", size: 999_999 },
        { baseDir, sessionId: "s", maxSize: 100, fetchImpl: makeFetch({}) },
      ),
      (e: unknown) => e instanceof AttachmentError && e.reason === "size",
    );
  });

  it("rejects disallowed mime declared by adapter", async () => {
    const baseDir = mkTmp();
    await assert.rejects(
      downloadAttachment(
        { url: "x", filename: "x.zip", mimeType: "application/zip" },
        { baseDir, sessionId: "s", fetchImpl: makeFetch({}) },
      ),
      (e: unknown) => e instanceof AttachmentError && e.reason === "mime",
    );
  });

  it("rejects disallowed mime detected from response headers", async () => {
    const baseDir = mkTmp();
    await assert.rejects(
      downloadAttachment(
        { url: "x", filename: "x.bin" },
        {
          baseDir,
          sessionId: "s",
          fetchImpl: makeFetch({ contentType: "video/mp4", body: new Uint8Array([1, 2, 3]) }),
        },
      ),
      (e: unknown) => e instanceof AttachmentError && e.reason === "mime",
    );
  });

  it("rejects when content-length exceeds limit", async () => {
    const baseDir = mkTmp();
    await assert.rejects(
      downloadAttachment(
        { url: "x", filename: "x.png" },
        {
          baseDir,
          sessionId: "s",
          maxSize: 10,
          fetchImpl: makeFetch({ contentType: "image/png", contentLength: 5000, body: new Uint8Array(5) }),
        },
      ),
      (e: unknown) => e instanceof AttachmentError && e.reason === "size",
    );
  });

  it("rejects when streamed bytes exceed limit", async () => {
    const baseDir = mkTmp();
    const big = new Uint8Array(100);
    await assert.rejects(
      downloadAttachment(
        { url: "x", filename: "x.png" },
        {
          baseDir,
          sessionId: "s",
          maxSize: 10,
          // No content-length advertised so check fires during streaming
          fetchImpl: makeFetch({ contentType: "image/png", body: big }),
        },
      ),
      (e: unknown) => e instanceof AttachmentError && e.reason === "size",
    );
  });

  it("reports HTTP errors", async () => {
    const baseDir = mkTmp();
    await assert.rejects(
      downloadAttachment(
        { url: "x", filename: "x.png", mimeType: "image/png" },
        {
          baseDir,
          sessionId: "s",
          fetchImpl: makeFetch({ status: 404, body: new Uint8Array() }),
        },
      ),
      (e: unknown) => e instanceof AttachmentError && e.reason === "download",
    );
  });

  it("reports network failures", async () => {
    const baseDir = mkTmp();
    await assert.rejects(
      downloadAttachment(
        { url: "x", filename: "x.png", mimeType: "image/png" },
        {
          baseDir,
          sessionId: "s",
          fetchImpl: makeFetch({ throwError: new Error("ECONNRESET") }),
        },
      ),
      (e: unknown) => e instanceof AttachmentError && e.reason === "download",
    );
  });

  it("sanitizes session id and filename when building path", async () => {
    const baseDir = mkTmp();
    const result = await downloadAttachment(
      { url: "x", filename: "../../evil.png", mimeType: "image/png", size: 3 },
      {
        baseDir,
        sessionId: "../../etc",
        fetchImpl: makeFetch({ contentType: "image/png", body: new Uint8Array([1, 2, 3]) }),
      },
    );
    const dir = path.dirname(result.path);
    // Per-session dir resolves under baseDir/.attachments
    assert.ok(dir.startsWith(path.join(baseDir, ".attachments")));
    // Sanitized filename has no parent traversal
    assert.ok(!path.basename(result.path).includes(".."));
    assert.ok(!path.basename(result.path).includes("/"));
  });
});
