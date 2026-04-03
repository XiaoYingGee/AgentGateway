import { describe, it, expect } from "vitest";
import {
  parseInteraction,
  createDeferredResponse,
  createPingResponse,
} from "../src/discord";
import { InteractionType, InteractionCallbackType } from "../src/types";
import type { DiscordInteraction } from "../src/types";

function makeInteraction(overrides: Partial<DiscordInteraction> = {}): DiscordInteraction {
  return {
    id: "int-123",
    type: InteractionType.APPLICATION_COMMAND,
    application_id: "app-123",
    token: "token-abc",
    channel_id: "ch-456",
    member: {
      user: { id: "user-1", username: "testuser", discriminator: "0" },
    },
    data: {
      id: "cmd-1",
      name: "claude",
      options: [{ name: "prompt", type: 3, value: "hello world" }],
    },
    ...overrides,
  };
}

describe("parseInteraction", () => {
  it("parses a valid APPLICATION_COMMAND into an AgentRequest", () => {
    const result = parseInteraction(makeInteraction());
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("hello world");
    expect(result!.userId).toBe("user-1");
    expect(result!.command).toBe("claude");
    expect(result!.channelId).toBe("ch-456");
  });

  it("extracts cwd option when provided", () => {
    const interaction = makeInteraction({
      data: {
        id: "cmd-1",
        name: "claude",
        options: [
          { name: "prompt", type: 3, value: "hello" },
          { name: "cwd", type: 3, value: "/home/user/project" },
        ],
      },
    });
    const result = parseInteraction(interaction);
    expect(result).not.toBeNull();
    expect(result!.cwd).toBe("/home/user/project");
  });

  it("returns null for PING interactions", () => {
    const result = parseInteraction(
      makeInteraction({ type: InteractionType.PING, data: undefined }),
    );
    expect(result).toBeNull();
  });

  it("returns null when prompt option is missing", () => {
    const result = parseInteraction(
      makeInteraction({
        data: { id: "cmd-1", name: "claude", options: [] },
      }),
    );
    expect(result).toBeNull();
  });

  it("extracts user from DM context (user field instead of member)", () => {
    const result = parseInteraction(
      makeInteraction({
        member: undefined,
        user: { id: "dm-user-1", username: "dmuser", discriminator: "0" },
      }),
    );
    expect(result!.userId).toBe("dm-user-1");
  });
});

describe("createDeferredResponse", () => {
  it("returns a type-5 JSON response", async () => {
    const res = createDeferredResponse();
    const body = await res.json();
    expect(body).toEqual({
      type: InteractionCallbackType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });
    expect(res.status).toBe(200);
  });
});

describe("createPingResponse", () => {
  it("returns a type-1 JSON response", async () => {
    const res = createPingResponse();
    const body = await res.json();
    expect(body).toEqual({ type: InteractionCallbackType.PONG });
    expect(res.status).toBe(200);
  });
});
