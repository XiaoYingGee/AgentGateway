import { Hono } from "hono";
import type { Bindings, DiscordInteraction } from "./types";
import { InteractionType } from "./types";
import {
  verifyDiscordSignature,
  parseInteraction,
  createDeferredResponse,
  createPingResponse,
} from "./discord";
import { isAllowedUser, checkRateLimit } from "./auth";
import { createSignedRequest } from "./signing";

const app = new Hono<{ Bindings: Bindings }>();

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/", (c) => c.text("agent-gateway ok"));

// ---------------------------------------------------------------------------
// Discord interactions webhook
// ---------------------------------------------------------------------------
app.post("/webhook", async (c) => {
  // 1. Verify Discord Ed25519 signature
  const { valid, body } = await verifyDiscordSignature(
    c.req.raw,
    c.env.DISCORD_PUBLIC_KEY,
  );

  if (!valid) {
    return c.text("Invalid signature", 401);
  }

  const interaction: DiscordInteraction = JSON.parse(body);

  // 2. Handle PING → PONG (Discord health-check)
  if (interaction.type === InteractionType.PING) {
    return createPingResponse();
  }

  // 3. Handle APPLICATION_COMMAND
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    // 3a. Extract user ID
    const userId =
      interaction.member?.user.id ?? interaction.user?.id ?? "";

    // 3b. Check whitelist
    if (!isAllowedUser(userId, c.env.ALLOWED_USERS)) {
      return Response.json(
        {
          type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
          data: {
            content: "You are not authorized to use this bot.",
            flags: 64, // EPHEMERAL — only visible to the invoking user
          },
        },
        { status: 200 },
      );
    }

    // 3c. Check rate limit
    const rateResult = await checkRateLimit(userId, c.env.RATE_LIMIT_KV);
    if (!rateResult.allowed) {
      return Response.json(
        {
          type: 4,
          data: {
            content: `Rate limit exceeded. Try again in ${rateResult.retryAfterSeconds}s.`,
            flags: 64,
          },
        },
        { status: 200 },
      );
    }

    // 3d. Parse the interaction into an AgentRequest
    const agentRequest = parseInteraction(interaction);
    if (!agentRequest) {
      return Response.json(
        {
          type: 4,
          data: {
            content:
              "Missing `prompt` option. Usage: `/claude prompt:your question here`",
            flags: 64,
          },
        },
        { status: 200 },
      );
    }

    // 3e. Return deferred response immediately, then forward async
    const agentEndpoint = c.env.AGENT_ENDPOINT;
    const hmacSecret = c.env.AGENT_HMAC_SECRET;

    c.executionCtx.waitUntil(
      forwardToAgent(agentEndpoint, agentRequest, hmacSecret),
    );

    return createDeferredResponse();
  }

  // Unknown interaction type — return 400
  return c.text("Unknown interaction type", 400);
});

// ---------------------------------------------------------------------------
// Async forwarding to agent service
// ---------------------------------------------------------------------------

async function forwardToAgent(
  endpoint: string,
  agentRequest: import("./types").AgentRequest,
  secret: string,
): Promise<void> {
  // Map gateway AgentRequest → agent-service AgentRequest
  const payload = {
    prompt: agentRequest.prompt,
    threadId: agentRequest.channelId, // Discord channel/thread as session key
    userId: agentRequest.userId,
    channelId: agentRequest.channelId,
    interactionToken: agentRequest.interactionToken,
    agentName: agentRequest.command === "claude" ? "claude-code" : agentRequest.command,
    cwd: agentRequest.cwd,
  };

  try {
    const request = await createSignedRequest(
      `${endpoint}/invoke`,
      payload,
      secret,
    );
    const response = await fetch(request);
    if (!response.ok) {
      console.error(
        `Agent service error: ${response.status} ${await response.text()}`,
      );
    }
  } catch (err) {
    console.error("Failed to forward request to agent service:", err);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default app;
