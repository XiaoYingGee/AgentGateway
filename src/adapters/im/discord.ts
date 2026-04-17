import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type OmitPartialGroupDMChannel,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { IMAdapter, InboundMessage, SendResult } from "../../core/types.js";

const MAX_BOT_CHAIN = 3;

export interface DiscordAdapterOptions {
  token: string;
  allowedUsers: string[];
  accountId?: string;
}

export class DiscordAdapter implements IMAdapter {
  readonly platform = "discord";
  readonly accountId: string;
  readonly capabilities = { threads: true, reactions: true };

  private client: Client;
  private token: string;
  private allowedUsers: string[];
  private handler?: (msg: InboundMessage) => Promise<void>;

  constructor(opts: DiscordAdapterOptions) {
    this.token = opts.token;
    this.allowedUsers = opts.allowedUsers;
    this.accountId = opts.accountId ?? "default";
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      // M2: disable default mention parsing
      allowedMentions: { parse: [] },
    });
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    this.client.once(Events.ClientReady, (c) => {
      console.log(`[discord] Online as ${c.user.tag} (ID: ${c.user.id})`);
    });

    this.client.on(Events.MessageCreate, (message: OmitPartialGroupDMChannel<Message>) => {
      // M3: outer try/catch to prevent unhandled rejection
      this.onDiscordMessage(message).catch((err) => {
        console.error(`[discord] Unhandled error in onDiscordMessage:`, err);
      });
    });

    await this.client.login(this.token);
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }

  // S2: sendMessage returns SendResult (R2)
  async sendMessage(params: {
    chatId: string;
    text: string;
    threadId?: string;
    replyToId?: string;
  }): Promise<SendResult> {
    const channelId = params.threadId ?? params.chatId;
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("send" in channel)) return { messageId: "", chatId: params.chatId, threadId: params.threadId };

    if (params.replyToId) {
      try {
        const target = await (channel as TextChannel).messages.fetch(params.replyToId);
        const sent = await target.reply(params.text);
        return { messageId: sent.id, chatId: params.chatId, threadId: params.threadId };
      } catch {
        // Fallback to plain send
      }
    }

    const sent = await (channel as TextChannel).send(params.text);
    return { messageId: sent.id, chatId: params.chatId, threadId: params.threadId };
  }

  // R2: editMessage uses SendResult target
  async editMessage(target: SendResult, text: string): Promise<void> {
    try {
      const channelId = target.threadId ?? target.chatId;
      const channel = await this.client.channels.fetch(channelId);
      if (channel && "messages" in channel) {
        const msg = await (channel as TextChannel).messages.fetch(target.messageId);
        await msg.edit(text);
      }
    } catch (err) {
      // L-1: log edit failures
      console.warn(`[discord] editMessage failed for ${target.messageId}:`, err);
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && "sendTyping" in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch {
      // Ignore typing errors
    }
  }

  private async onDiscordMessage(message: OmitPartialGroupDMChannel<Message>): Promise<void> {
    if (!this.handler) return;
    if (message.author.id === this.client.user!.id) return;
    if (!message.mentions.has(this.client.user!.id)) return;

    // M2: Bot whitelist — fail-closed
    // If allowedUsers is empty, reject everyone. Bots are always rejected unless explicitly listed.
    if (this.allowedUsers.length === 0) {
      return; // fail-closed: no allowedUsers configured → reject all
    }
    if (!this.allowedUsers.includes(message.author.id)) {
      return; // not in whitelist → reject (both bots and humans)
    }

    const text = message.content.replace(/<@!?\d+>/g, "").trim();
    if (!text) return;

    const channel = message.channel as TextChannel | ThreadChannel;

    // Chain limit check
    const recentMsgs = await channel.messages.fetch({ limit: MAX_BOT_CHAIN + 1 });
    const sorted = recentMsgs.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    let consecutiveBots = 0;
    for (const [, m] of sorted) {
      if (m.author.bot) consecutiveBots++;
      else break;
    }
    if (consecutiveBots >= MAX_BOT_CHAIN) {
      await message.reply("Bot chain limit reached. Please send a message to continue.");
      return;
    }

    // M1: Session key with user dimension
    // Format: discord:guild:<guildId>:channel:<channelId>:user:<userId>
    // DM: discord:dm:user:<userId>
    // Future: could be configured to "shared" strategy (omit user segment)
    const guildId = message.guildId;
    const isThread = channel.isThread();

    let sessionKey: string;
    // S3: chatId is always the real channel (for threads, use parent channel)
    let chatId: string;

    if (!guildId) {
      // DM
      sessionKey = `discord:dm:user:${message.author.id}`;
      chatId = channel.id;
    } else if (isThread) {
      // Thread — chatId = parent channelId, not threadId
      chatId = (channel as ThreadChannel).parentId ?? channel.id;
      sessionKey = `discord:guild:${guildId}:channel:${chatId}:user:${message.author.id}`;
    } else {
      chatId = channel.id;
      sessionKey = `discord:guild:${guildId}:channel:${chatId}:user:${message.author.id}`;
    }

    const inbound: InboundMessage = {
      platform: "discord",
      sessionKey,
      chatId, // S3: explicit chatId
      accountId: this.accountId,
      userId: message.author.id,
      userName: message.author.username,
      text,
      threadId: isThread ? channel.id : undefined,
      replyToId: message.id,
      raw: message,
    };

    await this.handler(inbound);
  }
}
