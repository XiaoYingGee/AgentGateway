import { describe, it } from "node:test";
import assert from "node:assert/strict";

// --- Test: CodexAdapter interface contract ---
import { CodexAdapter } from "../src/adapters/ai/codex.ts";

describe("CodexAdapter", () => {
  it("can be instantiated", () => {
    const adapter = new CodexAdapter();
    assert.ok(adapter);
  });

  it("implements AIAdapter interface fields", () => {
    const adapter = new CodexAdapter();
    assert.strictEqual(adapter.name, "codex");
    assert.strictEqual(adapter.supportsResume, false);
    assert.strictEqual(typeof adapter.invoke, "function");
    assert.strictEqual(typeof adapter.killAll, "function");
  });

  it("invoke returns a promise", () => {
    const adapter = new CodexAdapter();
    const result = adapter.invoke({ prompt: "test" });
    assert.ok(result instanceof Promise);
    result.catch(() => {});
  });
});

// --- Test: OpenCodeAdapter interface contract ---
import { OpenCodeAdapter } from "../src/adapters/ai/opencode.ts";

describe("OpenCodeAdapter", () => {
  it("can be instantiated", () => {
    const adapter = new OpenCodeAdapter();
    assert.ok(adapter);
  });

  it("implements AIAdapter interface fields", () => {
    const adapter = new OpenCodeAdapter();
    assert.strictEqual(adapter.name, "opencode");
    assert.strictEqual(adapter.supportsResume, false);
    assert.strictEqual(typeof adapter.invoke, "function");
    assert.strictEqual(typeof adapter.killAll, "function");
  });

  it("invoke returns a promise", () => {
    const adapter = new OpenCodeAdapter();
    const result = adapter.invoke({ prompt: "test" });
    assert.ok(result instanceof Promise);
    result.catch(() => {});
  });
});

// --- Test: Slack splitMessage with display limit ---
import { splitMessage } from "../src/utils/messages.ts";

describe("Slack splitMessage", () => {
  it("splits at Slack display limit (3000 chars)", () => {
    const longText = "x".repeat(6500);
    const segments = splitMessage(longText, 3000);
    assert.ok(segments.length >= 3, `expected >=3 segments, got ${segments.length}`);
    for (const seg of segments) {
      assert.ok(seg.length <= 3000, `segment too long: ${seg.length}`);
    }
    // All content preserved
    assert.strictEqual(segments.join("").length, 6500);
  });

  it("does not split short messages", () => {
    const segments = splitMessage("hello slack", 3000);
    assert.deepStrictEqual(segments, ["hello slack"]);
  });
});

// --- Test: Slack whitelist fail-closed ---
describe("Slack whitelist", () => {
  function isAllowed(allowedUsers: string[], userId: string): boolean {
    if (allowedUsers.length === 0) return false;
    return allowedUsers.includes(userId);
  }

  it("fail-closed when allowedUsers is empty", () => {
    assert.strictEqual(isAllowed([], "U12345"), false);
  });

  it("rejects user not in whitelist", () => {
    assert.strictEqual(isAllowed(["U111", "U222"], "U999"), false);
  });

  it("allows user in whitelist", () => {
    assert.strictEqual(isAllowed(["U111", "U222"], "U111"), true);
  });
});

// --- Test: Slack session key format ---
import { buildSlackSessionKey } from "../src/adapters/im/slack.ts";

describe("Slack session key format", () => {
  it("DM uses slack:dm:user:<userId>", () => {
    const key = buildSlackSessionKey("im", "D123", "U456");
    assert.strictEqual(key, "slack:dm:user:U456");
  });

  it("channel without thread", () => {
    const key = buildSlackSessionKey("channel", "C123", "U456");
    assert.strictEqual(key, "slack:channel:C123:user:U456");
  });

  it("channel with thread", () => {
    const key = buildSlackSessionKey("channel", "C123", "U456", "1234567890.123456");
    assert.strictEqual(key, "slack:channel:C123:thread:1234567890.123456:user:U456");
  });
});
