import pkg from "@slack/bolt";
const { App } = pkg;
import type { IMAdapter, InboundMessage, SendResult } from "../../core/types.js";
import { BaseIMAdapter } from "./base.js";
import { splitMessage } from "../../utils/messages.js";

const SLACK_DISPLAY_MAX = 3000;

export interface SlackAdapterOptions {
  botToken: string;
  appToken: string;
  allowedUsers: string[];
  accountId?: string;
  autoReplyInDM?: boolean;
  autoReplyInThreads?: boolean;
}

export class SlackAdapter extends BaseIMAdapter implements IMAdapter {
  readonly platform = "slack";
  readonly accountId: string;
  readonly capabilities = { threads: true, reactions: true };

  private app: InstanceType<typeof App>;
  private botUserId?: string;
  private allowedUsers: string[];
  private autoReplyInDM: boolean;
  private autoReplyInThreads: boolean;
  private handler?: (msg: InboundMessage) => Promise<void>;

  constructor(opts: SlackAdapterOptions) {
    super();
    this.allowedUsers = opts.allowedUsers;
    this.accountId = opts.accountId ?? "default";
    this.autoReplyInDM = opts.autoReplyInDM ?? true;
    this.autoReplyInThreads = opts.autoReplyInThreads ?? true;
    this.app = new App({
      token: opts.botToken,
      appToken: opts.appToken,
      socketMode: true,
    });
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    // Listen for direct messages and mentions
    this.app.event("message", async ({ event, context }) => {
      this.onSlackMessage(event as any, context).catch((err) => {
        console.error(`[slack] Unhandled error in onSlackMessage:`, err);
      });
    });

    this.app.event("app_mention", async ({ event, context }) => {
      this.onSlackMention(event as any, context).catch((err) => {
        console.error(`[slack] Unhandled error in onSlackMention:`, err);
      });
    });

    await this.app.start();
    // Fetch bot's own user ID for mention stripping
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      console.log(`[slack] Online as ${auth.user} (ID: ${this.botUserId})`);
    } catch (err) {
      console.error(`[slack] auth.test failed:`, err);
    }
  }

  async disconnect(): Promise<void> {
    await this.app.stop();
  }

  async sendMessage(params: {
    chatId: string;
    text: string;
    threadId?: string;
    replyToId?: string;
  }): Promise<SendResult> {
    const segments = splitMessage(params.text, SLACK_DISPLAY_MAX);

    let firstTs = "";
    for (const segment of segments) {
      const result = await this.app.client.chat.postMessage({
        channel: params.chatId,
        text: segment,
        ...(params.threadId ? { thread_ts: params.threadId } : {}),
      });
      if (!firstTs) firstTs = result.ts as string;
    }

    return {
      messageId: firstTs,
      chatId: params.chatId,
      threadId: params.threadId,
    };
  }

  async editMessage(target: SendResult, text: string): Promise<void> {
    try {
      const truncated =
        text.length > SLACK_DISPLAY_MAX
          ? text.slice(0, SLACK_DISPLAY_MAX - 4) + " ..."
          : text;
      await this.app.client.chat.update({
        channel: target.chatId,
        ts: target.messageId,
        text: truncated,
      });
    } catch {
      // Edit failed, non-fatal
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    // Slack doesn't have a typing indicator API for bots
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      // Slack uses emoji names without colons (e.g. "hourglass_flowing_sand" not ":hourglass_flowing_sand:")
      const name = emojiToSlackName(emoji);
      await this.app.client.reactions.add({
        channel: chatId,
        timestamp: messageId,
        name,
      });
    } catch {
      // Silent — bot may lack reactions:write scope
    }
  }

  async unreact(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const name = emojiToSlackName(emoji);
      await this.app.client.reactions.remove({
        channel: chatId,
        timestamp: messageId,
        name,
      });
    } catch {
      // Silent — reaction may not exist or message deleted
    }
  }

  private isAllowed(userId: string): boolean {
    if (this.allowedUsers.length === 0) return false;
    return this.allowedUsers.includes(userId);
  }

  private async onSlackMessage(event: any, _context: any): Promise<void> {
    if (!this.handler) return;
    // Ignore bot messages and subtypes (edits, joins, etc.)
    if (event.subtype || event.bot_id) return;

    const userId = event.user;
    if (!userId) return;

    const isDM = event.channel_type === "im";
    const isThread = !!event.thread_ts;

    // Auto-reply logic: DMs don't need mention, threads don't need mention (if enabled)
    // Channel messages without thread require @mention (handled by app_mention event)
    if (!isDM && !(isThread && this.autoReplyInThreads)) return;

    if (!this.isAllowed(userId)) {
      console.log(`[slack][debug] rejected message from ${userId}: not in whitelist`);
      return;
    }

    const text = this.stripMention(event.text ?? "").trim();
    if (!text) return;

    const chatId = event.channel;
    const threadId = event.thread_ts as string | undefined;

    const sessionKey = isDM
      ? `slack:dm:user:${userId}`
      : threadId
        ? `slack:channel:${chatId}:thread:${threadId}:user:${userId}`
        : `slack:channel:${chatId}:user:${userId}`;

    const inbound: InboundMessage = {
      platform: "slack",
      sessionKey,
      chatId,
      accountId: this.accountId,
      userId,
      userName: undefined,
      text,
      threadId,
      replyToId: event.ts,
      raw: event,
    };

    await this.handler(inbound);
  }

  private async onSlackMention(event: any, _context: any): Promise<void> {
    if (!this.handler) return;

    const userId = event.user;
    if (!userId) return;

    // If thread auto-reply is enabled and this is a thread message,
    // skip — already handled by onSlackMessage to avoid duplicates
    if (this.autoReplyInThreads && event.thread_ts) return;

    if (!this.isAllowed(userId)) {
      console.log(`[slack][debug] rejected mention from ${userId}: not in whitelist`);
      return;
    }

    const text = this.stripMention(event.text ?? "").trim();
    if (!text) return;

    const chatId = event.channel;
    const threadId = event.thread_ts as string | undefined;

    const sessionKey = threadId
      ? `slack:channel:${chatId}:thread:${threadId}:user:${userId}`
      : `slack:channel:${chatId}:user:${userId}`;

    const inbound: InboundMessage = {
      platform: "slack",
      sessionKey,
      chatId,
      accountId: this.accountId,
      userId,
      userName: undefined,
      text,
      threadId,
      replyToId: event.ts,
      raw: event,
    };

    await this.handler(inbound);
  }

  private stripMention(text: string): string {
    // Slack mentions look like <@U12345>
    return text.replace(/<@[A-Z0-9]+>/gi, "").trim();
  }
}

/** Exported for testing */
export function buildSlackSessionKey(
  channelType: "im" | "channel",
  chatId: string,
  userId: string,
  threadId?: string,
): string {
  if (channelType === "im") {
    return `slack:dm:user:${userId}`;
  }
  const base = `slack:channel:${chatId}`;
  const threadPart = threadId ? `:thread:${threadId}` : "";
  return `${base}${threadPart}:user:${userId}`;
}

/** Map Unicode emoji to Slack reaction name */
const EMOJI_MAP: Record<string, string> = {
  "⏳": "hourglass_flowing_sand",
  "✅": "white_check_mark",
  "❌": "x",
};

function emojiToSlackName(emoji: string): string {
  return EMOJI_MAP[emoji] ?? emoji;
}
