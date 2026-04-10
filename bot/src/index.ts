import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type OmitPartialGroupDMChannel,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { config } from "./config.js";
import { invokeClaude } from "./claude.js";
import { splitMessage } from "./messages.js";

const MAX_BOT_CHAIN = 3;
const EDIT_INTERVAL_MS = 2000;
const DISCORD_MAX_LEN = 1900;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Online as ${c.user.tag} (ID: ${c.user.id})`);
  console.log(`[bot] Allowed users: ${config.allowedUsers.join(", ")}`);
  console.log(`[bot] Default CWD: ${config.defaultCwd}`);
});

client.on(Events.MessageCreate, async (message: OmitPartialGroupDMChannel<Message>) => {
  if (message.author.id === client.user!.id) return;
  if (!message.mentions.has(client.user!.id)) return;
  if (!message.author.bot && !config.allowedUsers.includes(message.author.id)) return;

  const prompt = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!prompt) {
    await message.reply("请输入你的问题或指令。");
    return;
  }

  const channel = message.channel as TextChannel | ThreadChannel;

  // Chain limit
  const recentMsgs = await channel.messages.fetch({ limit: MAX_BOT_CHAIN + 1 });
  const sorted = recentMsgs.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  let consecutiveBots = 0;
  for (const [, m] of sorted) {
    if (m.author.bot) consecutiveBots++;
    else break;
  }
  if (consecutiveBots >= MAX_BOT_CHAIN) {
    console.log(`[bot] Chain limit reached (${consecutiveBots})`);
    await message.reply("Bot chain limit reached. Please send a message to continue.");
    return;
  }

  // Send initial streaming message
  let streamMsg: Message;
  try {
    streamMsg = await message.reply("\u23f3 Thinking...");
    console.log(`[bot] Sent initial reply (id=${streamMsg.id})`);
  } catch (replyErr) {
    console.error(`[bot] Failed to send initial reply:`, replyErr);
    return;
  }

  // Progressive streaming state
  const finalizedSegments: string[] = [];
  let currentText = "";
  let lastEditTime = 0;
  let editPending = false;
  let streamDone = false;

  const SPLIT_THRESHOLD = 1500;

  const findSplit = (text: string, max: number): number => {
    for (let i = max - 1; i > max / 2; i--) {
      if (text[i] === "\n") return i + 1;
    }
    const lastNl = text.lastIndexOf("\n", max);
    return lastNl > max / 4 ? lastNl + 1 : max;
  };

  const flushEdit = async () => {
    if (!currentText) return;
    const display = currentText.length > DISCORD_MAX_LEN
      ? currentText.slice(0, DISCORD_MAX_LEN)
      : currentText;
    await streamMsg.edit(display).catch((e) => console.error(`[bot] edit error:`, e));
  };

  const scheduleEdit = () => {
    if (editPending || streamDone) return;
    const now = Date.now();
    const wait = Math.max(0, EDIT_INTERVAL_MS - (now - lastEditTime));

    editPending = true;
    setTimeout(async () => {
      editPending = false;
      lastEditTime = Date.now();
      await flushEdit();
    }, wait);
  };

  const updateStream = async (fullText: string) => {
    const prefixLen = finalizedSegments.reduce((sum, s) => sum + s.length, 0);
    currentText = fullText.slice(prefixLen);

    while (currentText.length > SPLIT_THRESHOLD) {
      const splitIdx = findSplit(currentText, SPLIT_THRESHOLD);
      const chunk = currentText.slice(0, splitIdx);
      finalizedSegments.push(chunk);

      await streamMsg.edit(chunk).catch((e) => console.error(`[bot] edit error:`, e));

      try {
        streamMsg = await channel.send("\u23f3 ...");
      } catch (e) {
        console.error(`[bot] Failed to send continuation msg:`, e);
        break;
      }

      currentText = currentText.slice(splitIdx);
    }

    scheduleEdit();
  };

  try {
    // Use channel ID for session continuity — Claude CLI handles history via --resume
    const result = await invokeClaude(prompt, channel.id, config.defaultCwd, (text) => {
      updateStream(text);
    });
    streamDone = true;

    // Final output: re-split cleanly
    const allSegments = splitMessage(result);

    const sentCount = finalizedSegments.length + 1;
    for (let i = 0; i < allSegments.length; i++) {
      if (i < sentCount - 1) {
        continue;
      } else if (i === sentCount - 1) {
        await streamMsg.edit(allSegments[i]!).catch((e) => console.error(`[bot] Failed to edit final msg:`, e));
      } else {
        await channel.send(allSegments[i]!).catch((e) => console.error(`[bot] Failed to send segment ${i}:`, e));
      }
    }
  } catch (err) {
    streamDone = true;
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[bot] Error in handler:`, errMsg);
    await streamMsg.edit(`Error: ${errMsg.slice(0, 1900)}`).catch((e) => console.error(`[bot] Failed to edit error msg:`, e));
  }
});

function shutdown() {
  console.log("[bot] Shutting down...");
  client.destroy();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

client.login(config.botToken);
