import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type OmitPartialGroupDMChannel,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { IMAdapter, InboundAttachment, InboundMessage, SendResult } from "../../core/types.js";

const MAX_BOT_CHAIN = 3;

export interface DiscordAdapterOptions {
  token: string;
  allowedUsers: string[];
  accountId?: string;
  autoReplyInDM?: boolean;
  autoReplyInThreads?: boolean;
}

export class DiscordAdapter implements IMAdapter {
  readonly platform = "discord";
  readonly accountId: string;
  readonly capabilities = { threads: true, reactions: true };

  private client: Client;
  private token: string;
  private allowedUsers: string[];
  private autoReplyInDM: boolean;
  private autoReplyInThreads: boolean;
  private handler?: (msg: InboundMessage) => Promise<void>;

  constructor(opts: DiscordAdapterOptions) {
    this.token = opts.token;
    this.allowedUsers = opts.allowedUsers;
    this.accountId = opts.accountId ?? "default";
    this.autoReplyInDM = opts.autoReplyInDM ?? true;
    this.autoReplyInThreads = opts.autoReplyInThreads ?? true;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
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

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && "messages" in channel) {
        const msg = await (channel as TextChannel).messages.fetch(messageId);
        await msg.react(emoji);
      }
    } catch {
      // Silent — bot may lack permission
    }
  }

  async unreact(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && "messages" in channel) {
        const msg = await (channel as TextChannel).messages.fetch(messageId);
        await msg.reactions.cache.get(emoji)?.users.remove(this.client.user!.id);
      }
    } catch {
      // Silent — message may have been deleted
    }
  }

  private async onDiscordMessage(message: OmitPartialGroupDMChannel<Message>): Promise<void> {
    if (!this.handler) return;
    if (message.author.id === this.client.user!.id) return;

    const isDM = !message.guildId;
    const isThread = !isDM && (message.channel as TextChannel | ThreadChannel).isThread();
    const mentioned = message.mentions.has(this.client.user!.id);

    // Auto-reply: skip mention check in DM or thread when enabled
    const mentionRequired = !(
      (isDM && this.autoReplyInDM) ||
      (isThread && this.autoReplyInThreads)
    );

    console.log(`[discord][debug] msg from=${message.author.id} guild=${message.guildId} ch=${message.channelId} mentioned=${mentioned} isDM=${isDM} isThread=${isThread} mentionRequired=${mentionRequired}`);
    if (mentionRequired && !mentioned) return;

    // M2: Bot whitelist — fail-closed
    // If allowedUsers is empty, reject everyone. Bots are always rejected unless explicitly listed.
    if (this.allowedUsers.length === 0) {
      console.log(`[discord][debug] rejected: no allowedUsers configured`);
      return; // fail-closed: no allowedUsers configured → reject all
    }
    if (!this.allowedUsers.includes(message.author.id)) {
      console.log(`[discord][debug] rejected: ${message.author.id} not in whitelist`);
      return; // not in whitelist → reject (both bots and humans)
    }

    const text = message.content.replace(/<@!?\d+>/g, "").trim();
    if (!text && message.attachments.size === 0) return;

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
    const guildId = message.guildId;

    let sessionKey: string;
    // S3: chatId is always the real channel (for threads, use parent channel)
    let chatId: string;

    if (isDM) {
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

    const attachments: InboundAttachment[] = [];
    for (const a of message.attachments.values()) {
      attachments.push({
        url: a.url,
        filename: a.name ?? `discord-${a.id}`,
        mimeType: a.contentType ?? undefined,
        size: typeof a.size === "number" ? a.size : undefined,
      });
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
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: message,
    };

    await this.handler(inbound);
  }
}
