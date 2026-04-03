import { describe, it, expect } from "vitest";
import { signRequest } from "../src/signing";

describe("signRequest", () => {
  const secret = "test-secret-key";

  it("produces a hex-encoded HMAC-SHA256 signature", async () => {
    const sig = await signRequest({ foo: "bar" }, secret, 1700000000);
    // Should be a 64-char hex string (256 bits)
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same signature for the same input", async () => {
    const payload = { action: "test" };
    const ts = 1700000000;
    const sig1 = await signRequest(payload, secret, ts);
    const sig2 = await signRequest(payload, secret, ts);
    expect(sig1).toBe(sig2);
  });

  it("produces different signatures for different payloads", async () => {
    const ts = 1700000000;
    const sig1 = await signRequest({ a: 1 }, secret, ts);
    const sig2 = await signRequest({ a: 2 }, secret, ts);
    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for different timestamps", async () => {
    const payload = { a: 1 };
    const sig1 = await signRequest(payload, secret, 1700000000);
    const sig2 = await signRequest(payload, secret, 1700000001);
    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for different secrets", async () => {
    const payload = { a: 1 };
    const ts = 1700000000;
    const sig1 = await signRequest(payload, "secret1", ts);
    const sig2 = await signRequest(payload, "secret2", ts);
    expect(sig1).not.toBe(sig2);
  });
});
