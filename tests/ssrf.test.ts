import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AttachmentError,
  assertSafeUrl,
  downloadAttachment,
  isPrivateIp,
  redactToken,
} from "../src/utils/attachments.ts";

function withoutOverride<T>(fn: () => Promise<T> | T): Promise<T> {
  const old = process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
  delete process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
  return Promise.resolve(fn()).finally(() => {
    if (old != null) process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"] = old;
  });
}

describe("SSRF: isPrivateIp", () => {
  const cases: [string, boolean][] = [
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.15.0.1", false],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["192.169.1.1", false],
    ["169.254.169.254", true],
    ["100.64.0.1", true],
    ["100.128.0.1", false],
    ["0.0.0.0", true],
    ["224.0.0.1", true],
    ["239.255.255.255", true],
    ["255.255.255.255", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["::1", true],
    ["::", true],
    ["fe80::1", true],
    ["fc00::1", true],
    ["fd00::1", true],
    ["ff02::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:8.8.8.8", false],
    ["2606:4700:4700::1111", false],
    ["not-an-ip", false],
  ];
  for (const [ip, expected] of cases) {
    it(`SSRF-IP ${ip} → ${expected}`, () => {
      assert.strictEqual(isPrivateIp(ip), expected);
    });
  }
});

describe("SSRF: assertSafeUrl protocol whitelist", () => {
  for (const proto of ["file:", "ftp:", "gopher:", "data:", "javascript:"]) {
    it(`rejects protocol ${proto}`, async () => {
      await withoutOverride(() =>
        assert.rejects(
          () => assertSafeUrl(`${proto}//example.com/x`),
          (e: any) => e instanceof AttachmentError && /protocol/i.test(e.message),
        ),
      );
    });
  }

  it("rejects malformed URL", async () => {
    await withoutOverride(() =>
      assert.rejects(
        () => assertSafeUrl("not-a-url"),
        (e: any) => e instanceof AttachmentError && /invalid|protocol/i.test(e.message),
      ),
    );
  });

  it("accepts https://example.com (DNS resolves to public IP)", async () => {
    await withoutOverride(() => assertSafeUrl("https://example.com/path"));
  });

  it("accepts http://example.com (http allowed)", async () => {
    await withoutOverride(() => assertSafeUrl("http://example.com/path"));
  });
});

describe("SSRF: assertSafeUrl IP-literal rejection", () => {
  for (const url of [
    "http://127.0.0.1/x",
    "http://10.0.0.1/x",
    "http://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/x",
    "http://[fe80::1]/x",
    "http://[fc00::1]/x",
    "http://0.0.0.0/x",
  ]) {
    it(`rejects ${url}`, async () => {
      await withoutOverride(() =>
        assert.rejects(
          () => assertSafeUrl(url),
          (e: any) => e instanceof AttachmentError && /non-routable|private|loopback/i.test(e.message),
        ),
      );
    });
  }
});

describe("SSRF: ATTACHMENT_ALLOW_PRIVATE_IPS override", () => {
  it("allows loopback when override is enabled", async () => {
    const old = process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
    process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"] = "true";
    try {
      await assertSafeUrl("http://127.0.0.1/x");
    } finally {
      if (old == null) delete process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"];
      else process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"] = old;
    }
  });
});

describe("SSRF: downloadAttachment integration", () => {
  it("blocks loopback URL by default", async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "agw-ssrf-"));
    await withoutOverride(() =>
      assert.rejects(
        () => downloadAttachment(
          { url: "http://127.0.0.1:1/x.png", filename: "x.png", mimeType: "image/png" },
          { baseDir, sessionId: "s", enforceUrlValidation: true },
        ),
        (e: any) => e instanceof AttachmentError && e.reason === "download",
      ),
    );
  });

  it("blocks file:// URL", async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "agw-ssrf-"));
    await withoutOverride(() =>
      assert.rejects(
        () => downloadAttachment(
          { url: "file:///etc/passwd", filename: "p", mimeType: "image/png" },
          { baseDir, sessionId: "s", enforceUrlValidation: true },
        ),
        (e: any) => e instanceof AttachmentError && e.reason === "download",
      ),
    );
  });
});

describe("redactToken", () => {
  it("redacts Telegram bot token", () => {
    const out = redactToken("https://api.telegram.org/file/bot1234567890:ABCDefghIJKL/path/to.jpg");
    assert.ok(!out.includes("ABCDefgh"));
    assert.ok(!out.includes("1234567890:"));
    assert.ok(out.includes("bot<redacted>"));
  });
  it("redacts ?token=... query", () => {
    const out = redactToken("https://example.com/x?token=secret123&other=ok");
    assert.ok(!out.includes("secret123"));
    assert.ok(out.includes("token=<redacted>"));
  });
  it("leaves clean URLs alone", () => {
    const out = redactToken("https://cdn.discordapp.com/x.png");
    assert.strictEqual(out, "https://cdn.discordapp.com/x.png");
  });
});
