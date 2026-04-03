import {
  type DiscordInteraction,
  type AgentRequest,
  InteractionType,
  InteractionCallbackType,
} from "./types";

// ---------------------------------------------------------------------------
// Ed25519 signature verification (Web Crypto API — CF Workers compatible)
// ---------------------------------------------------------------------------

/**
 * Convert a hex string to a Uint8Array.
 */
function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Verify a Discord webhook request's Ed25519 signature.
 *
 * Discord sends two headers:
 *   - `X-Signature-Ed25519`  — hex-encoded signature
 *   - `X-Signature-Timestamp` — timestamp string
 *
 * The signed message is `${timestamp}${rawBody}`.
 *
 * Returns `true` when the signature is valid.
 */
export async function verifyDiscordSignature(
  request: Request,
  publicKeyHex: string,
): Promise<{ valid: boolean; body: string }> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");

  if (!signature || !timestamp) {
    return { valid: false, body: "" };
  }

  const body = await request.text();
  const message = new TextEncoder().encode(timestamp + body);

  const publicKeyBytes = hexToUint8Array(publicKeyHex);
  const signatureBytes = hexToUint8Array(signature);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    publicKeyBytes,
    { name: "Ed25519", namedCurve: "Ed25519" },
    false,
    ["verify"],
  );

  const valid = await crypto.subtle.verify(
    "Ed25519",
    cryptoKey,
    signatureBytes,
    message,
  );

  return { valid, body };
}

// ---------------------------------------------------------------------------
// Interaction parsing
// ---------------------------------------------------------------------------

/** Extract the user's ID from a Discord interaction (guild or DM). */
function getUserId(interaction: DiscordInteraction): string {
  return interaction.member?.user.id ?? interaction.user?.id ?? "";
}

/** Extract the username from a Discord interaction (guild or DM). */
function getUsername(interaction: DiscordInteraction): string {
  return interaction.member?.user.username ?? interaction.user?.username ?? "";
}

/**
 * Parse an APPLICATION_COMMAND interaction into an `AgentRequest` payload
 * ready to be forwarded to the agent service.
 */
export function parseInteraction(
  interaction: DiscordInteraction,
): AgentRequest | null {
  if (
    interaction.type !== InteractionType.APPLICATION_COMMAND ||
    !interaction.data
  ) {
    return null;
  }

  const promptOption = interaction.data.options?.find(
    (o) => o.name === "prompt",
  );
  const prompt =
    typeof promptOption?.value === "string" ? promptOption.value : "";

  const cwdOption = interaction.data.options?.find(
    (o) => o.name === "cwd",
  );
  const cwd =
    typeof cwdOption?.value === "string" ? cwdOption.value : undefined;

  if (!prompt) {
    return null;
  }

  return {
    interactionId: interaction.id,
    interactionToken: interaction.token,
    applicationId: interaction.application_id,
    userId: getUserId(interaction),
    username: getUsername(interaction),
    channelId: interaction.channel_id,
    guildId: interaction.guild_id,
    command: interaction.data.name,
    prompt,
    cwd,
  };
}

// ---------------------------------------------------------------------------
// Discord response helpers
// ---------------------------------------------------------------------------

/**
 * Return a DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE response (type 5).
 * Discord will show a "thinking..." indicator while the agent works.
 */
export function createDeferredResponse(): Response {
  return Response.json(
    { type: InteractionCallbackType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE },
    { status: 200 },
  );
}

/**
 * Return a PONG response (type 1) for Discord's ping health-check.
 */
export function createPingResponse(): Response {
  return Response.json(
    { type: InteractionCallbackType.PONG },
    { status: 200 },
  );
}
