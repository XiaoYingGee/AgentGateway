import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { Router } from "../src/core/router.ts";
import type { AIAdapter, InboundMessage } from "../src/core/types.ts";

function mkTmp(): string { return mkdtempSync(path.join(tmpdir(), "agw-r2-")); }

function startStaticServer(handler: (req: any, res: any) => void): Promise<{ server: Server; url: (p: string) => string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address() as AddressInfo;
      resolve({ server, url: (p: string) => `http://127.0.0.1:${a.port}${p}` });
    });
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

describe("R2: router attachment failure semantics", () => {
  it("attachment failure causes ❌ reaction (not ✅) — return false bubbles to react", async () => {
    const { server, url } = await startStaticServer((_req, res) => {
      res.writeHead(500); res.end("nope");
    });
    try {
      const baseDir = mkTmp();
      const router = new Router({ defaultCwd: baseDir });
      const im = createMockIM();
      const ai: AIAdapter = {
        name: "ai", supportsResume: false,
        async invoke() { return { text: "x", exitCode: 0 }; },
      };
      router.registerIM(im); router.registerAI(ai);

      await im.inject(makeMsg({
        text: "x",
        attachments: [{ url: url("/x.png"), filename: "x.png", mimeType: "image/png" }],
      }));

      const reacted = im.reactions.filter((r: any) => r.kind === "react").map((r: any) => r.emoji);
      assert.ok(reacted.includes("❌"), `expected ❌ reaction, got: ${reacted.join(",")}`);
      assert.ok(!reacted.includes("✅"), `should not show ✅ when attachment failed: ${reacted.join(",")}`);
      router["sessions"].destroy();
    } finally { server.close(); }
  });
});

describe("R2: router multi-attachment partial-failure cleanup (QA-7.5)", () => {
  it("first attachment downloads, second fails — first file is unlinked", async () => {
    const ok = Buffer.from("good-data");
    const { server, url } = await startStaticServer((req, res) => {
      if (req.url?.includes("good")) {
        res.writeHead(200, { "content-type": "image/png", "content-length": String(ok.length) });
        res.end(ok);
      } else {
        res.writeHead(500); res.end("bad");
      }
    });
    try {
      const baseDir = mkTmp();
      const router = new Router({ defaultCwd: baseDir });
      const im = createMockIM();
      let aiCalls = 0;
      const ai: AIAdapter = {
        name: "ai", supportsResume: false,
        async invoke() { aiCalls++; return { text: "x", exitCode: 0 }; },
      };
      router.registerIM(im); router.registerAI(ai);

      // Snapshot files before / after to confirm cleanup
      const { readdirSync, existsSync: ex } = await import("node:fs");
      await im.inject(makeMsg({
        text: "x",
        attachments: [
          { url: url("/good.png"), filename: "g.png", mimeType: "image/png" },
          { url: url("/bad.png"), filename: "b.png", mimeType: "image/png" },
        ],
      }));
      assert.strictEqual(aiCalls, 0, "AI must not be invoked when any attachment fails");

      // Walk the .attachments dir — there should be no leftover .png files
      const root = path.join(baseDir, ".attachments");
      let leftover = 0;
      if (ex(root)) {
        for (const session of readdirSync(root)) {
          for (const f of readdirSync(path.join(root, session))) {
            if (f.endsWith(".png")) leftover++;
          }
        }
      }
      assert.strictEqual(leftover, 0, `expected no leftover attachment files after partial failure, found ${leftover}`);
      router["sessions"].destroy();
    } finally { server.close(); }
  });
});

describe("R2: queue preserves per-message attachments (QA-7.2)", () => {
  it("3 quick messages with distinct attachments — each attachment surfaces in a prompt", async () => {
    const bodies = [Buffer.from("img-0"), Buffer.from("img-1"), Buffer.from("img-2")];
    const { server, url } = await startStaticServer((req, res) => {
      const m = req.url?.match(/\/i(\d)\.png/);
      if (m) {
        const body = bodies[Number(m[1])]!;
        res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
        res.end(body);
        return;
      }
      res.writeHead(404); res.end();
    });
    try {
      const baseDir = mkTmp();
      const router = new Router({ defaultCwd: baseDir });
      const im = createMockIM();
      const prompts: string[] = [];
      let resolveSlow: (v: any) => void = () => {};
      const slow = new Promise((r) => { resolveSlow = r; });
      let firstCall = true;
      const ai: AIAdapter = {
        name: "ai", supportsResume: false,
        async invoke(p) {
          prompts.push(p.prompt);
          if (firstCall) {
            firstCall = false;
            // hold the first invocation so msgs 1 + 2 enqueue
            await slow;
          }
          return { text: "ok", exitCode: 0 };
        },
      };
      router.registerIM(im); router.registerAI(ai);

      // Send first message — starts AI which blocks on `slow`
      const inject = im.inject(makeMsg({
        text: "m0",
        replyToId: "msg-0",
        attachments: [{ url: url(`/i0.png`), filename: `i0.png`, mimeType: "image/png", size: bodies[0]!.length }],
      }));
      // Tiny delay so the first message has time to mark busy + start the invoke
      await new Promise((r) => setTimeout(r, 50));
      // Send msg #1 + #2 while busy — they enqueue
      const p1 = im.inject(makeMsg({
        text: "m1",
        replyToId: "msg-1",
        attachments: [{ url: url(`/i1.png`), filename: `i1.png`, mimeType: "image/png", size: bodies[1]!.length }],
      }));
      const p2 = im.inject(makeMsg({
        text: "m2",
        replyToId: "msg-2",
        attachments: [{ url: url(`/i2.png`), filename: `i2.png`, mimeType: "image/png", size: bodies[2]!.length }],
      }));
      await Promise.all([p1, p2]);
      // Now release the first AI invocation so the drain loop runs
      resolveSlow(undefined);
      await inject;
      // Wait a beat for drain to finish
      await new Promise((r) => setTimeout(r, 200));

      // We expect 2 invocations: msg0 alone, then combined drain of msg1+msg2.
      assert.ok(prompts.length >= 2, `expected >= 2 prompts (initial + drain), got ${prompts.length}`);
      const all = prompts.join("\n\n---\n\n");
      // Every attachment must appear (none silently dropped)
      assert.ok(all.includes("i0.png"), "msg0 attachment missing");
      assert.ok(all.includes("i1.png"), "msg1 attachment missing in drain prompt — QA-7.2 regression");
      assert.ok(all.includes("i2.png"), "msg2 attachment missing in drain prompt — QA-7.2 regression");
      router["sessions"].destroy();
    } finally { server.close(); }
  });
});
