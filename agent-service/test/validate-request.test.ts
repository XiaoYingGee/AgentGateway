import { describe, it, expect } from "vitest";
import { validateRequest } from "../src/index";

const VALID: Record<string, unknown> = {
  prompt: "hello",
  threadId: "t-001",
  agentName: "claude-code",
  interactionToken: "tok-001",
  userId: "u-001",
  channelId: "c-001",
};

function with_(overrides: Record<string, unknown>) {
  return { ...VALID, ...overrides };
}

function without_(...keys: string[]) {
  const copy = { ...VALID };
  for (const k of keys) delete copy[k];
  return copy;
}

describe("validateRequest", () => {
  it("accepts a fully valid request", () => {
    const result = validateRequest(VALID);
    expect(result.valid).toBe(true);
  });

  it("accepts with optional cwd", () => {
    const result = validateRequest(with_({ cwd: "D:/Workspace" }));
    expect(result.valid).toBe(true);
  });

  it("accepts with extra unknown fields (ignored)", () => {
    const result = validateRequest(with_({ foo: "bar", nested: { a: 1 } }));
    expect(result.valid).toBe(true);
  });

  // --- Required fields ---

  it("rejects missing prompt", () => {
    const result = validateRequest(without_("prompt"));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("prompt");
  });

  it("rejects empty prompt", () => {
    const result = validateRequest(with_({ prompt: "" }));
    expect(result.valid).toBe(false);
  });

  it("rejects missing threadId", () => {
    const result = validateRequest(without_("threadId"));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("threadId");
  });

  it("rejects missing agentName", () => {
    const result = validateRequest(without_("agentName"));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("agentName");
  });

  it("rejects missing interactionToken", () => {
    const result = validateRequest(without_("interactionToken"));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("interactionToken");
  });

  it("rejects empty interactionToken", () => {
    const result = validateRequest(with_({ interactionToken: "" }));
    expect(result.valid).toBe(false);
  });

  // --- Type enforcement ---

  it("rejects numeric threadId", () => {
    const result = validateRequest(with_({ threadId: 12345 }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("threadId");
  });

  it("rejects numeric prompt", () => {
    const result = validateRequest(with_({ prompt: 42 }));
    expect(result.valid).toBe(false);
  });

  it("rejects null interactionToken", () => {
    const result = validateRequest(with_({ interactionToken: null }));
    expect(result.valid).toBe(false);
  });

  it("rejects boolean agentName", () => {
    const result = validateRequest(with_({ agentName: true }));
    expect(result.valid).toBe(false);
  });

  // --- Optional fields ---

  it("allows null userId and channelId (optional)", () => {
    const result = validateRequest(with_({ userId: null, channelId: null }));
    expect(result.valid).toBe(true);
  });

  it("allows missing userId and channelId", () => {
    const result = validateRequest(without_("userId", "channelId"));
    expect(result.valid).toBe(true);
  });

  it("rejects numeric cwd", () => {
    const result = validateRequest(with_({ cwd: 123 }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("cwd");
  });

  // --- Edge cases ---

  it("rejects null body", () => {
    const result = validateRequest(null);
    expect(result.valid).toBe(false);
  });

  it("rejects non-object body", () => {
    const result = validateRequest("hello");
    expect(result.valid).toBe(false);
  });

  it("rejects array body", () => {
    const result = validateRequest([1, 2, 3]);
    expect(result.valid).toBe(false);
  });
});
