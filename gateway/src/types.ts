// ---------------------------------------------------------------------------
// Discord interaction types
// ---------------------------------------------------------------------------

/** Discord interaction type codes */
export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

/** Discord interaction callback type codes */
export const InteractionCallbackType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
} as const;

/** Minimal shape of a Discord slash-command option */
export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
}

/** Minimal shape of a Discord interaction payload */
export interface DiscordInteraction {
  id: string;
  type: number;
  application_id: string;
  token: string;
  /** Present for APPLICATION_COMMAND */
  data?: {
    id: string;
    name: string;
    options?: CommandOption[];
  };
  /** User who triggered the interaction (guild context) */
  member?: {
    user: {
      id: string;
      username: string;
      discriminator: string;
    };
  };
  /** User who triggered the interaction (DM context) */
  user?: {
    id: string;
    username: string;
    discriminator: string;
  };
  channel_id: string;
  guild_id?: string;
  /** Thread/channel message was sent in — may differ from channel_id in threads */
  channel?: {
    id: string;
    type: number;
    name?: string;
    parent_id?: string;
  };
}

// ---------------------------------------------------------------------------
// Internal request types (gateway → agent service)
// ---------------------------------------------------------------------------

/** Payload forwarded to the agent service */
export interface AgentRequest {
  /** Discord interaction ID */
  interactionId: string;
  /** Discord interaction token (needed for deferred-message editing) */
  interactionToken: string;
  /** Discord application ID */
  applicationId: string;
  /** Discord user ID who initiated the request */
  userId: string;
  /** Username for display purposes */
  username: string;
  /** The channel/thread ID for context continuity */
  channelId: string;
  /** Guild ID if applicable */
  guildId?: string;
  /** Slash command name (e.g. "claude") */
  command: string;
  /** The user's prompt text */
  prompt: string;
  /** Optional working directory override */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// CF Worker environment bindings
// ---------------------------------------------------------------------------

export type Bindings = {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APP_ID: string;
  ALLOWED_USERS: string;
  AGENT_HMAC_SECRET: string;
  AGENT_ENDPOINT: string;
  RATE_LIMIT_KV: KVNamespace;
};
