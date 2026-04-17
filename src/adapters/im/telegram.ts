import { Bot, type Context } from "grammy";
import type { IMAdapter, InboundMessage, SendResult } from "../../core/types.js";
import { BaseIMAdapter } from "./base.js";
import { splitMessage } from "../../utils/messages.js";

const TELEGRAM_MAX = 4096;

export interface TelegramAdapterOptions {
  token: string;
  allowedUsers: string[];
  accountId?: string;
  autoReplyInDM?: boolean;
  autoReplyInThreads?: boolean;
}

export class TelegramAdapter extends BaseIMAdapter implements IMAdapter {
  readonly platform = "telegram";
  readonly accountId: string;
  readonly capabilities = { threads: true, reactions: false };

  private bot: Bot;
  private allowedUsers: string[];
  private autoReplyInDM: boolean;
  private autoReplyInThreads: boolean;
  private handler?: (msg: InboundMessage) => Promise<void>;

  constructor(opts: TelegramAdapterOptions) {
    super();
    this.allowedUsers = opts.allowedUsers;
    this.accountId = opts.accountId ?? "default";
    this.autoReplyInDM = opts.autoReplyInDM ?? true;
    this.autoReplyInThreads = opts.autoReplyInThreads ?? true;
    this.bot = new Bot(opts.token);
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    this.bot.on("message:text", (ctx) => {
      this.onTelegramMessage(ctx).catch((err) => {
        console.error(`[telegram] Unhandled error in onTelegramMessage:`, err);
      });
    });

    // R3: validate token before starting long-poll
    await this.bot.init();
    console.log(`[telegram] Token valid, bot: ${this.bot.botInfo.username}`);

    // Start long-polling in background — crash logged but doesn't kill process
    this.bot.start({
      onStart: (info) => {
        console.log(`[telegram] Online as ${info.username} (ID: ${info.id})`);
      },
    }).catch((err) => {
      // P5: mark adapter unhealthy on long-poll crash
      this.healthy = false;
      console.error(`[telegram] Long-poll crashed:`, err);
    });
  }

  async disconnect(): Promise<void> {
    await this.bot.stop();
  }

  async sendMessage(params: {
    chatId: string;
    text: string;
    threadId?: string;
    replyToId?: string;
  }): Promise<SendResult> {
    const chatId = params.chatId;
    const segments = splitMessage(params.text, TELEGRAM_MAX);

    let firstMessageId = "";
    for (const segment of segments) {
      const sent = await this.bot.api.sendMessage(chatId, segment, {
        ...(params.threadId
          ? { message_thread_id: Number(params.threadId) }
          : {}),
        ...(params.replyToId && !firstMessageId
          ? { reply_parameters: { message_id: Number(params.replyToId) } }
          : {}),
      });
      if (!firstMessageId) firstMessageId = String(sent.message_id);
    }

    return { messageId: firstMessageId, chatId, threadId: params.threadId };
  }

  // R2: editMessage uses SendResult target — chatId is the real chat id
  async editMessage(target: SendResult, text: string): Promise<void> {
    try {
      const truncated =
        text.length > TELEGRAM_MAX
          ? text.slice(0, TELEGRAM_MAX - 4) + " ..."
          : text;
      await this.bot.api.editMessageText(
        target.chatId,
        Number(target.messageId),
        truncated,
      );
    } catch {
      // Edit failed, non-fatal
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(chatId, "typing");
    } catch {
      // Ignore typing errors
    }
  }

  private async onTelegramMessage(ctx: Context): Promise<void> {
    if (!this.handler) return;

    const msg = ctx.message;
    if (!msg || !msg.text) return;

    // Ignore messages from bots
    if (msg.from?.is_bot) return;

    const userId = String(msg.from!.id);

    // Whitelist — fail-closed
    if (this.allowedUsers.length === 0) return;
    if (!this.allowedUsers.includes(userId)) return;

    const text = msg.text.trim();
    if (!text) return;

    const chatId = String(msg.chat.id);
    const chatType = msg.chat.type; // "private" | "group" | "supergroup" | "channel"
    const threadId = msg.message_thread_id
      ? String(msg.message_thread_id)
      : undefined;

    // Mention check for groups: require @bot_username unless auto-reply applies
    const isPrivate = chatType === "private";
    const isThread = !!threadId;
    const autoReply = (isPrivate && this.autoReplyInDM) || (isThread && this.autoReplyInThreads);

    if (!isPrivate && !autoReply) {
      // In groups, require @bot_username mention
      const botUsername = this.bot.botInfo?.username;
      if (!botUsername || !text.includes(`@${botUsername}`)) return;
    }

    // Strip bot mention from text
    const botUser = this.bot.botInfo?.username;
    const cleanText = botUser
      ? text.split(`@${botUser}`).join("").trim()
      : text;
    if (!cleanText) return;

    const sessionKey = buildSessionKey(chatType, chatId, userId, threadId);

    const inbound: InboundMessage = {
      platform: "telegram",
      sessionKey,
      chatId,
      accountId: this.accountId,
      userId,
      userName: msg.from!.username ?? msg.from!.first_name,
      text: cleanText,
      threadId,
      replyToId: String(msg.message_id),
      raw: msg,
    };

    await this.handler(inbound);
  }
}

/** Exported for testing */
export function buildSessionKey(
  chatType: string,
  chatId: string,
  userId: string,
  threadId?: string,
): string {
  if (chatType === "private") {
    return `telegram:private:user:${userId}`;
  }
  // group / supergroup / channel
  const base = `telegram:group:${chatId}`;
  const topicPart = threadId ? `:topic:${threadId}` : "";
  return `${base}${topicPart}:user:${userId}`;
}
