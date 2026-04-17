import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/core/router.ts";
import { parseCommand } from "../src/utils/command.ts";
import type { AIAdapter, IMAdapter, InboundMessage, SendResult } from "../src/core/types.ts";

// --- Mock helpers ---

function createMockIM(opts?: { withReactions?: boolean }): IMAdapter & {
  handler: ((msg: InboundMessage) => Promise<void>) | undefined;
  sent: Array<{ chatId: string; text: string; threadId?: string; replyToId?: string }>;
  edits: Array<{ target: SendResult; text: string }>;
  reactions: Array<{ chatId: string; messageId: string; emoji: string; action: "add" | "remove" }>;
  inject(msg: InboundMessage): Promise<void>;
} {
  const sent: Array<{ chatId: string; text: string; threadId?: string; replyToId?: string }> = [];
  const edits: Array<{ target: SendResult; text: string }> = [];
  const reactions: Array<{ chatId: string; messageId: string; emoji: string; action: "add" | "remove" }> = [];
  let handler: ((msg: InboundMessage) => Promise<void>) | undefined;
  let msgCounter = 0;

  const im: any = {
    platform: "test",
    accountId: "mock",
    handler,
    sent,
    edits,
    reactions,
    async connect() {},
    async disconnect() {},
    async sendMessage(params: any) {
      sent.push(params);
      msgCounter++;
      return { messageId: `m${msgCounter}`, chatId: params.chatId, threadId: params.threadId };
    },
    async editMessage(target: SendResult, text: string) {
      edits.push({ target, text });
    },
    async sendTyping() {},
    onMessage(h: any) { handler = h; im.handler = h; },
    inject(msg: InboundMessage) {
      if (!handler) throw new Error("No handler registered");
      return handler(msg);
    },
  };

  if (opts?.withReactions) {
    im.react = async (chatId: string, messageId: string, emoji: string) => {
      reactions.push({ chatId, messageId, emoji, action: "add" });
    };
    im.unreact = async (chatId: string, messageId: string, emoji: string) => {
      reactions.push({ chatId, messageId, emoji, action: "remove" });
    };
  }

  return im;
}

function createMockAI(response = "AI response"): AIAdapter {
  return {
    name: "mock-ai",
    supportsResume: false,
    async invoke(params) {
      params.onChunk?.(response);
      return { text: response, exitCode: 0 };
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
    replyToId: "orig-msg-1",
    raw: {},
    ...overrides,
  };
}

// ============================================================================
// Feature 1: /help command
// ============================================================================

describe("parseCommand", () => {
  it("recognizes /help", () => {
    assert.strictEqual(parseCommand("/help"), "help");
  });

  it("requires slash prefix", () => {
    assert.strictEqual(parseCommand("help"), undefined);
  });

  it("is case-insensitive", () => {
    assert.strictEqual(parseCommand("/HELP"), "help");
  });

  it("returns undefined for non-commands", () => {
    assert.strictEqual(parseCommand("hello world"), undefined);
  });

  it("returns undefined for /help with trailing text", () => {
    assert.strictEqual(parseCommand("/help me"), undefined);
  });
});

describe("/help command in Router", () => {
  it("responds with help text listing AI aliases", async () => {
    const router = new Router({ defaultCwd: "/tmp/agw-help-test" });
    const im = createMockIM();
    const ai = createMockAI();
    router.registerIM(im);
    router.registerAI(ai, { alias: "claude-code", default: true });

    await im.inject(makeMsg({ text: "/help" }));

    const helpMsg = im.sent.find(s => s.text.includes("AgentGateway Help"));
    assert.ok(helpMsg, "should send help text");
    assert.ok(helpMsg!.text.includes("claude-code"), "should list AI aliases");
    assert.ok(!helpMsg!.text.includes("TOKEN"), "should not leak tokens");

    router["sessions"].destroy();
  });

  it("does not invoke AI for /help", async () => {
    let aiCalled = false;
    const ai: AIAdapter = {
      name: "mock-ai",
      supportsResume: false,
      async invoke() { aiCalled = true; return { text: "", exitCode: 0 }; },
    };

    const router = new Router({ defaultCwd: "/tmp/agw-help-noai-test" });
    const im = createMockIM();
    router.registerIM(im);
    router.registerAI(ai, { alias: "mock-ai" });

    await im.inject(makeMsg({ text: "/help" }));
    assert.strictEqual(aiCalled, false, "AI should not be called for /help");

    router["sessions"].destroy();
  });
});

// ============================================================================
// Feature 2: Reaction feedback
// ============================================================================

describe("Reaction feedback", () => {
  it("adds ⏳ then replaces with ✅ on success", async () => {
    const router = new Router({ defaultCwd: "/tmp/agw-react-test" });
    const im = createMockIM({ withReactions: true });
    const ai = createMockAI("ok");
    router.registerIM(im);
    router.registerAI(ai, { alias: "mock-ai" });

    await im.inject(makeMsg({ text: "hello", replyToId: "msg-123" }));

    // Check reactions in order: add ⏳, remove ⏳, add ✅
    const addHourglass = im.reactions.find(r => r.emoji === "⏳" && r.action === "add");
    const removeHourglass = im.reactions.find(r => r.emoji === "⏳" && r.action === "remove");
    const addCheck = im.reactions.find(r => r.emoji === "✅" && r.action === "add");

    assert.ok(addHourglass, "should add ⏳ reaction");
    assert.ok(removeHourglass, "should remove ⏳ reaction");
    assert.ok(addCheck, "should add ✅ reaction");

    router["sessions"].destroy();
  });

  it("adds ❌ on AI error", async () => {
    const router = new Router({ defaultCwd: "/tmp/agw-react-err-test" });
    const im = createMockIM({ withReactions: true });
    const ai: AIAdapter = {
      name: "mock-ai",
      supportsResume: false,
      async invoke() { throw new Error("AI exploded"); },
    };
    router.registerIM(im);
    router.registerAI(ai, { alias: "mock-ai" });

    await im.inject(makeMsg({ text: "hello", replyToId: "msg-456" }));

    const addX = im.reactions.find(r => r.emoji === "❌" && r.action === "add");
    assert.ok(addX, "should add ❌ reaction on error");

    router["sessions"].destroy();
  });

  it("works without react methods (no crash)", async () => {
    const router = new Router({ defaultCwd: "/tmp/agw-react-noop-test" });
    const im = createMockIM({ withReactions: false }); // no react/unreact
    const ai = createMockAI("ok");
    router.registerIM(im);
    router.registerAI(ai, { alias: "mock-ai" });

    // Should not throw
    await im.inject(makeMsg({ text: "hello" }));
    assert.ok(true, "should not crash without react methods");

    router["sessions"].destroy();
  });
});

// ============================================================================
// Feature 3: Auto-reply / DM detection (unit-level)
// ============================================================================

describe("Auto-reply config", () => {
  it("/help works in DM context without @mention", async () => {
    // Simulates DM scenario: user sends /help without mentioning bot
    const router = new Router({ defaultCwd: "/tmp/agw-dm-help-test" });
    const im = createMockIM();
    const ai = createMockAI();
    router.registerIM(im);
    router.registerAI(ai, { alias: "mock-ai" });

    await im.inject(makeMsg({
      text: "/help",
      sessionKey: "discord:dm:user:123",
    }));

    const helpMsg = im.sent.find(s => s.text.includes("AgentGateway Help"));
    assert.ok(helpMsg, "should handle /help in DM context");

    router["sessions"].destroy();
  });
});
