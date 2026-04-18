import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sweepAttachments, startAttachmentGc, getAttachmentTtlMs } from "../src/utils/attachments-gc.ts";

function mkTmp(): string { return mkdtempSync(path.join(tmpdir(), "agw-gc-")); }

function touchOld(p: string, ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
}

describe("attachments-gc: getAttachmentTtlMs", () => {
  it("defaults to 24h", () => {
    const old = process.env["ATTACHMENT_TTL_HOURS"];
    delete process.env["ATTACHMENT_TTL_HOURS"];
    try {
      assert.strictEqual(getAttachmentTtlMs(), 24 * 60 * 60 * 1000);
    } finally { if (old != null) process.env["ATTACHMENT_TTL_HOURS"] = old; }
  });
  it("respects env override", () => {
    const old = process.env["ATTACHMENT_TTL_HOURS"];
    process.env["ATTACHMENT_TTL_HOURS"] = "2";
    try {
      assert.strictEqual(getAttachmentTtlMs(), 2 * 60 * 60 * 1000);
    } finally { if (old == null) delete process.env["ATTACHMENT_TTL_HOURS"]; else process.env["ATTACHMENT_TTL_HOURS"] = old; }
  });
  it("0 means disabled", () => {
    const old = process.env["ATTACHMENT_TTL_HOURS"];
    process.env["ATTACHMENT_TTL_HOURS"] = "0";
    try {
      assert.strictEqual(getAttachmentTtlMs(), 0);
    } finally { if (old == null) delete process.env["ATTACHMENT_TTL_HOURS"]; else process.env["ATTACHMENT_TTL_HOURS"] = old; }
  });
});

describe("attachments-gc: sweepAttachments", () => {
  it("removes files older than ttlMs and keeps newer ones", async () => {
    const baseDir = mkTmp();
    const root = path.join(baseDir, ".attachments", "session1");
    mkdirSync(root, { recursive: true });
    const oldFile = path.join(root, "old.png");
    const newFile = path.join(root, "new.png");
    writeFileSync(oldFile, "old");
    writeFileSync(newFile, "new");
    touchOld(oldFile, 2 * 60 * 60 * 1000); // 2h old

    const removed = await sweepAttachments(baseDir, 60 * 60 * 1000); // 1h TTL
    assert.strictEqual(removed, 1);
    assert.ok(!existsSync(oldFile), "old file should be removed");
    assert.ok(existsSync(newFile), "fresh file should remain");
  });

  it("removes empty per-session directories after sweep", async () => {
    const baseDir = mkTmp();
    const sessionDir = path.join(baseDir, ".attachments", "abc");
    mkdirSync(sessionDir, { recursive: true });
    const f = path.join(sessionDir, "x.png");
    writeFileSync(f, "x");
    touchOld(f, 5 * 60 * 60 * 1000);

    await sweepAttachments(baseDir, 60 * 60 * 1000);
    assert.ok(!existsSync(sessionDir), "empty session dir should be removed");
  });

  it("ttl=0 disables sweep", async () => {
    const baseDir = mkTmp();
    const root = path.join(baseDir, ".attachments", "s");
    mkdirSync(root, { recursive: true });
    const f = path.join(root, "old.png");
    writeFileSync(f, "x");
    touchOld(f, 100 * 60 * 60 * 1000);
    const removed = await sweepAttachments(baseDir, 0);
    assert.strictEqual(removed, 0);
    assert.ok(existsSync(f));
  });

  it("returns 0 when .attachments/ doesn't exist (no error)", async () => {
    const baseDir = mkTmp();
    const removed = await sweepAttachments(baseDir, 1000);
    assert.strictEqual(removed, 0);
  });

  it("multiple sessions are swept independently", async () => {
    const baseDir = mkTmp();
    for (const s of ["sa", "sb", "sc"]) {
      const dir = path.join(baseDir, ".attachments", s);
      mkdirSync(dir, { recursive: true });
      const f = path.join(dir, "x.png");
      writeFileSync(f, "x");
      touchOld(f, 10 * 60 * 60 * 1000);
    }
    const removed = await sweepAttachments(baseDir, 60 * 60 * 1000);
    assert.strictEqual(removed, 3);
    assert.strictEqual(readdirSync(path.join(baseDir, ".attachments")).length, 0);
  });
});

describe("attachments-gc: startAttachmentGc", () => {
  it("returns a stop function and runs an initial sweep", async () => {
    const baseDir = mkTmp();
    const dir = path.join(baseDir, ".attachments", "s");
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "old.png");
    writeFileSync(f, "x");
    touchOld(f, 10 * 60 * 60 * 1000);

    const stop = startAttachmentGc({ baseDir, intervalMs: 60_000, ttlMs: 60 * 60 * 1000 });
    // Allow the initial sweep promise to settle
    await new Promise((r) => setTimeout(r, 50));
    stop();
    assert.ok(!existsSync(f), "initial sweep should remove the old file");
  });

  it("ttl=0 returns no-op stop", () => {
    const baseDir = mkTmp();
    const stop = startAttachmentGc({ baseDir, ttlMs: 0 });
    assert.strictEqual(typeof stop, "function");
    stop(); // must not throw
  });
});
