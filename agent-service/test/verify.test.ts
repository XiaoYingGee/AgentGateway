import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { verifyRequest } from "../src/verify";

function makeSignature(body: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

describe("verifyRequest", () => {
  const secret = "test-secret";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a valid signature with current timestamp", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const body = '{"prompt":"hello"}';
    const sig = makeSignature(body, secret, ts);

    const valid = await verifyRequest(body, sig, String(ts), secret);
    expect(valid).toBe(true);
  });

  it("rejects an invalid signature", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const body = '{"prompt":"hello"}';
    const sig = "0".repeat(64); // wrong signature

    const valid = await verifyRequest(body, sig, String(ts), secret);
    expect(valid).toBe(false);
  });

  it("rejects a stale timestamp (> 5 minutes old)", async () => {
    const ts = Math.floor(Date.now() / 1000) - 6 * 60; // 6 minutes ago
    const body = '{"prompt":"hello"}';
    const sig = makeSignature(body, secret, ts);

    const valid = await verifyRequest(body, sig, String(ts), secret);
    expect(valid).toBe(false);
  });

  it("accepts a timestamp within the 5 minute window", async () => {
    const ts = Math.floor(Date.now() / 1000) - 4 * 60; // 4 minutes ago
    const body = '{"prompt":"hello"}';
    const sig = makeSignature(body, secret, ts);

    const valid = await verifyRequest(body, sig, String(ts), secret);
    expect(valid).toBe(true);
  });

  it("rejects a non-numeric timestamp", async () => {
    const body = '{"prompt":"hello"}';
    const valid = await verifyRequest(body, "abc", "not-a-number", secret);
    expect(valid).toBe(false);
  });

  it("rejects a signature with wrong secret", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const body = '{"prompt":"hello"}';
    const sig = makeSignature(body, "wrong-secret", ts);

    const valid = await verifyRequest(body, sig, String(ts), secret);
    expect(valid).toBe(false);
  });
});
