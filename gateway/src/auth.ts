// ---------------------------------------------------------------------------
// User whitelist
// ---------------------------------------------------------------------------

/**
 * Check whether `userId` is present in a comma-separated allowlist string.
 *
 * Example `allowedUsers` value: `"123456789,987654321"`.
 */
export function isAllowedUser(userId: string, allowedUsers: string): boolean {
  if (!userId || !allowedUsers) return false;
  const set = new Set(
    allowedUsers.split(",").map((id) => id.trim()).filter(Boolean),
  );
  return set.has(userId);
}

// ---------------------------------------------------------------------------
// KV-based per-user rate limiting
// ---------------------------------------------------------------------------

/**
 * Check (and increment) a per-user rate limit counter stored in KV.
 *
 * Uses a KV key like `rl:<userId>:<windowSlot>` with a TTL equal to
 * `windowSeconds` so entries expire automatically.
 *
 * Returns `{ allowed: true }` when under the limit, or
 * `{ allowed: false, retryAfterSeconds }` when the limit is exceeded.
 */
export async function checkRateLimit(
  userId: string,
  kv: KVNamespace,
  limit: number = 20,
  windowSeconds: number = 60,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  // Deterministic window slot based on epoch time
  const now = Math.floor(Date.now() / 1000);
  const windowSlot = Math.floor(now / windowSeconds);
  const key = `rl:${userId}:${windowSlot}`;

  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= limit) {
    const windowEnd = (windowSlot + 1) * windowSeconds;
    return { allowed: false, retryAfterSeconds: windowEnd - now };
  }

  // Increment — KV put is eventually consistent but good enough for rate
  // limiting (slightly over-counting is acceptable; strict atomicity is not
  // required at our scale).
  await kv.put(key, String(count + 1), {
    expirationTtl: windowSeconds * 2, // 2x window to cover clock skew
  });

  return { allowed: true };
}
