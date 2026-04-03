import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Verify an HMAC-SHA256 signed request.
 *
 * Signature scheme: HMAC-SHA256( secret, `${timestamp}.${body}` )
 * The caller must provide the hex-encoded signature and the unix-second timestamp.
 */
export async function verifyRequest(
  body: string,
  signature: string,
  timestamp: string,
  secret: string,
): Promise<boolean> {
  // --- anti-replay: reject stale timestamps ---
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;

  const age = Math.abs(Date.now() - ts * 1000);
  if (age > MAX_TIMESTAMP_AGE_MS) return false;

  // --- HMAC verification ---
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  if (expected.length !== signature.length) return false;

  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signature, "hex"),
  );
}

/**
 * Hono middleware that verifies HMAC-SHA256 on every request (except health).
 *
 * Expected headers:
 *   X-Signature    – hex-encoded HMAC
 *   X-Timestamp    – Unix seconds
 */
export function verifyMiddleware(secret: string) {
  return async (c: Context, next: Next) => {
    // Allow health checks without auth
    if (c.req.path === "/health") {
      await next();
      return;
    }

    const signature = c.req.header("x-signature");
    const timestamp = c.req.header("x-timestamp");

    if (!signature || !timestamp) {
      return c.json({ error: "Missing signature headers" }, 401);
    }

    const body = await c.req.text();

    const valid = await verifyRequest(body, signature, timestamp, secret);
    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    // Stash the raw body so downstream handlers can re-read it
    c.set("rawBody", body);
    await next();
  };
}
