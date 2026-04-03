import { describe, it, expect } from "vitest";
import { splitMessage } from "../src/discord";

describe("splitMessage", () => {
  it("returns single segment for short messages", () => {
    const result = splitMessage("hello world");
    expect(result).toEqual(["hello world"]);
  });

  it("splits long messages at newline boundaries", () => {
    const line = "a".repeat(100) + "\n";
    const content = line.repeat(25); // 25 * 101 = 2525 chars
    const segments = splitMessage(content, 200);

    for (const seg of segments) {
      expect(seg.length).toBeLessThanOrEqual(200 + 10); // small buffer for code block repair
    }
    // All content should be preserved
    expect(segments.join("")).toBe(content);
  });

  it("preserves code blocks across splits", () => {
    const code = "```\n" + "x\n".repeat(500) + "```\n";
    const text = "Before\n" + code + "After\n";
    const segments = splitMessage(text, 200);

    // Each segment should have balanced code fences
    for (const seg of segments) {
      const fenceCount = (seg.match(/^```/gm) || []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it("handles messages with no newlines", () => {
    const content = "a".repeat(300);
    const segments = splitMessage(content, 100);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.join("")).toBe(content);
  });

  it("handles empty content", () => {
    expect(splitMessage("")).toEqual([""]);
  });

  it("handles content exactly at the limit", () => {
    const content = "a".repeat(100);
    expect(splitMessage(content, 100)).toEqual([content]);
  });
});
