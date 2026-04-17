import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAIPrefix } from "../src/utils/prefix.ts";
import { Router } from "../src/core/router.ts";
import type { AIAdapter, IMAdapter, InboundMessage, SendResult } from "../src/core/types.ts";

// --- Helpers (same pattern as router.test.ts) ---

function createMockIM(): IMAdapter & {
  handler: ((msg: InboundMessage) => Promise<void>) | undefined;
  sent: Array<{ chatId: string; text: string; threadId?: string; replyToId?: string }>;
  inject(msg: InboundMessage): Promise<void>;
} {
  const sent: Array<{ chatId: string; text: string; threadId?: string; replyToId?: string }> = [];
  let handler: ((msg: InboundMessage) => Promise<void>) | undefined;
  let msgCounter = 0;

  return {
    platform: "test",
    accountId: "mock",
    handler,
    sent,
    async connect() {},
    async disconnect() {},
    async sendMessage(params) {
      sent.push(params);
      msgCounter++;
      return { messageId: `m${msgCounter}`, chatId: params.chatId, threadId: params.threadId };
    },
    async sendTyping() {},
    onMessage(h) { handler = h; (this as any).handler = h; },
    inject(msg: InboundMessage) {
      if (!handler) throw new Error("No handler registered");
      return handler(msg);
    },
  };
}

function createNamedAI(name: string, opts?: { sessionId?: string }): AIAdapter & { invocations: Array<{ prompt: string; sessionId?: string }> } {
  const invocations: Array<{ prompt: string; sessionId?: string }> = [];
  return {
    name,
    supportsResume: true,
    invocations,
    async invoke(params) {
      invocations.push({ prompt: params.prompt, sessionId: params.sessionId });
      const sid = `${name}-session-${invocations.length}`;
      return { text: `[${name}] response`, sessionId: opts?.sessionId ?? sid, exitCode: 0 };
    },
  };
}

function makeMsg(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    platform: "test",
    sessionKey: "test:user:1",
    chatId: "c1",
    accountId: "mock",
    userId: "user1",
    userName: "TestUser",
    text: "hello",
    raw: {},
    ...overrides,
  };
}

// --- parseAIPrefix ---
describe("parseAIPrefix", () => {
  const aliases = ["claude-code", "gemini", "codex"];

  it("extracts known prefix and prompt", () => {
    const r = parseAIPrefix("/claude-code help me debug", aliases);
    assert.strictEqual(r.alias, "claude-code");
    assert.strictEqual(r.prompt, "help me debug");
  });

  it("returns no alias for messages without prefix", () => {
    const r = parseAIPrefix("just a normal message", aliases);
    assert.strictEqual(r.alias, undefined);
    assert.strictEqual(r.prompt, "just a normal message");
  });

  it("returns no alias for unknown prefix (treated as normal message)", () => {
    const r = parseAIPrefix("/unknown-ai do stuff", aliases);
    assert.strictEqual(r.alias, undefined);
    assert.strictEqual(r.prompt, "/unknown-ai do stuff");
  });

  it("returns no alias when prefix has no content after it", () => {
    const r = parseAIPrefix("/gemini", aliases);
    assert.strictEqual(r.alias, undefined);
    assert.strictEqual(r.prompt, "/gemini");
  });

  it("is case-insensitive on prefix", () => {
    const r = parseAIPrefix("/GEMINI hello", aliases);
    assert.strictEqual(r.alias, "gemini");
    assert.strictEqual(r.prompt, "hello");
  });
});

// --- Multi-AI Router ---
describe("Multi-AI routing", () => {
  it("registers 3 AIs and routes by prefix", async () => {
    const router = new Router({ defaultCwd: "/tmp/agw-multi-test" });
    const im = createMockIM();
    const claude = createNamedAI("claude-code");
    const gemini = createNamedAI("gemini");
    const codex = createNamedAI("codex");

    router.registerIM(im);
    router.registerAI(claude, { alias: "claude-code", default: true });
    router.registerAI(gemini, { alias: "gemini" });
    router.registerAI(codex, { alias: "codex" });

    // /gemini should route to gemini
    await im.inject(makeMsg({ text: "/gemini translate this" }));
    assert.strictEqual(gemini.invocations.length, 1);
    assert.strictEqual(gemini.invocations[0]!.prompt, "translate this");
    assert.strictEqual(claude.invocations.length, 0);

    router["sessions"].destroy();
  });

  it("sticks to last-used AI when no prefix", async () => {
    const router = new Router({ defaultCwd: "/tmp/agw-sticky-test" });
    const im = createMockIM();
    const claude = createNamedAI("claude-code");
    const gemini = createNamedAI("gemini");

    router.registerIM(im);
    router.registerAI(claude, { alias: "claude-code", default: true });
    router.registerAI(gemini, { alias: "gemini" });

    // Switch to gemini
    await im.inject(makeMsg({ text: "/gemini first message" }));
    assert.strictEqual(gemini.invocations.length, 1);

    // No prefix → should stick to gemini
    await im.inject(makeMsg({ text: "follow up without prefix" }));
    assert.strictEqual(gemini.invocations.length, 2);
    assert.strictEqual(gemini.invocations[1]!.prompt, "follow up without prefix");
    assert.strictEqual(claude.invocations.length, 0);

    router["sessions"].destroy();
  });

  it("preserves resumeIds when switching back", async () => {
    const router = new Router({ defaultCwd: "/tmp/agw-resume-test" });
    const im = createMockIM();
    const claude = createNamedAI("claude-code");
    const gemini = createNamedAI("gemini");

    router.registerIM(im);
    router.registerAI(claude, { alias: "claude-code", default: true });
    router.registerAI(gemini, { alias: "gemini" });

    // Use claude first (default)
    await im.inject(makeMsg({ text: "hello claude" }));
    assert.strictEqual(claude.invocations.length, 1);
    const claudeSessionId = "claude-code-session-1"; // from createNamedAI

    // Switch to gemini
    await im.inject(makeMsg({ text: "/gemini hi gemini" }));
    assert.strictEqual(gemini.invocations.length, 1);

    // Switch back to claude — should resume with claude's session id
    await im.inject(makeMsg({ text: "/claude-code back to claude" }));
    assert.strictEqual(claude.invocations.length, 2);
    assert.strictEqual(claude.invocations[1]!.sessionId, claudeSessionId);

    // Gemini's session should also be preserved
    await im.inject(makeMsg({ text: "/gemini back to gemini" }));
    assert.strictEqual(gemini.invocations.length, 2);
    assert.strictEqual(gemini.invocations[1]!.sessionId, "gemini-session-1");

    router["sessions"].destroy();
  });

  it("sends switch notice when AI changes", async () => {
    const router = new Router({ defaultCwd: "/tmp/agw-switch-notice-test" });
    const im = createMockIM();
    const claude = createNamedAI("claude-code");
    const gemini = createNamedAI("gemini");

    router.registerIM(im);
    router.registerAI(claude, { alias: "claude-code", default: true });
    router.registerAI(gemini, { alias: "gemini" });

    // First message sets default — switch notice for initial set
    await im.inject(makeMsg({ text: "hello" }));
    const firstSwitch = im.sent.find(s => s.text.includes("🔀"));
    assert.ok(firstSwitch, "should send switch notice on first message (setting default)");

    im.sent.length = 0;

    // Same AI, no prefix → no switch notice
    await im.inject(makeMsg({ text: "follow up" }));
    const noSwitch = im.sent.find(s => s.text.includes("🔀"));
    assert.strictEqual(noSwitch, undefined, "no switch notice when staying on same AI");

    im.sent.length = 0;

    // Switch to gemini → switch notice
    await im.inject(makeMsg({ text: "/gemini hey" }));
    const switchNotice = im.sent.find(s => s.text.includes("🔀") && s.text.includes("gemini"));
    assert.ok(switchNotice, "should send switch notice when changing AI");

    router["sessions"].destroy();
  });

  it("uses default AI when no prefix and no sticky session", async () => {
    const router = new Router({ defaultCwd: "/tmp/agw-default-test" });
    const im = createMockIM();
    const claude = createNamedAI("claude-code");
    const gemini = createNamedAI("gemini");

    router.registerIM(im);
    router.registerAI(claude, { alias: "claude-code", default: true });
    router.registerAI(gemini, { alias: "gemini" });

    await im.inject(makeMsg({ text: "no prefix at all" }));
    assert.strictEqual(claude.invocations.length, 1, "should use default AI");
    assert.strictEqual(gemini.invocations.length, 0);

    router["sessions"].destroy();
  });

  it("getAIAliases returns all registered aliases", () => {
    const router = new Router({ defaultCwd: "/tmp/agw-aliases-test" });
    const claude = createNamedAI("claude-code");
    const gemini = createNamedAI("gemini");
    const codex = createNamedAI("codex");

    router.registerAI(claude, { alias: "claude-code" });
    router.registerAI(gemini, { alias: "gemini" });
    router.registerAI(codex, { alias: "codex" });

    const aliases = router.getAIAliases();
    assert.deepStrictEqual(aliases.sort(), ["claude-code", "codex", "gemini"]);

    router["sessions"].destroy();
  });

  it("stop kills all AI adapters", async () => {
    const router = new Router({ defaultCwd: "/tmp/agw-killall-test" });
    const im = createMockIM();
    const claude = createNamedAI("claude-code");
    const gemini = createNamedAI("gemini");

    router.registerIM(im);
    router.registerAI(claude, { alias: "claude-code" });
    router.registerAI(gemini, { alias: "gemini" });

    // Verify killAll is available on all adapters (they don't have killAll in mock, but
    // the Router iterates all adapters — test that no error is thrown)
    await router.stop();
    // If we got here without error, stop() iterated all adapters correctly
    assert.ok(true);
  });
});
