// ---------------------------------------------------------------------------
// HMAC-SHA256 request signing (Web Crypto API — CF Workers compatible)
// ---------------------------------------------------------------------------

/**
 * Generate an HMAC-SHA256 signature for a request payload.
 *
 * The signed message is `${timestamp}.${JSON.stringify(payload)}`.
 *
 * Returns the hex-encoded signature string.
 */
export async function signRequest(
  payload: unknown,
  secret: string,
  timestamp: number,
): Promise<string> {
  const message = `${timestamp}.${JSON.stringify(payload)}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );

  // Convert ArrayBuffer to hex string
  const bytes = new Uint8Array(signatureBuffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build a signed HTTP request ready to be sent to the agent service.
 *
 * Returns a `Request` object with:
 *   - JSON body containing the payload
 *   - `X-Signature` header with the HMAC hex digest
 *   - `X-Timestamp` header with the Unix timestamp (seconds)
 *   - `Content-Type: application/json`
 */
export async function createSignedRequest(
  url: string,
  payload: unknown,
  secret: string,
): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signRequest(payload, secret, timestamp);
  const body = JSON.stringify(payload);

  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature": signature,
      "X-Timestamp": String(timestamp),
    },
    body,
  });
}
