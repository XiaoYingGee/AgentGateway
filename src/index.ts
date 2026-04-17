import "dotenv/config";
import { existsSync, accessSync, constants } from "node:fs";
import { Router } from "./core/router.js";
import { DiscordAdapter } from "./adapters/im/discord.js";
import { TelegramAdapter } from "./adapters/im/telegram.js";
import { ClaudeCodeAdapter } from "./adapters/ai/claude-code.js";
import { GeminiAdapter } from "./adapters/ai/gemini.js";
import { CodexAdapter } from "./adapters/ai/codex.js";
import { OpenCodeAdapter } from "./adapters/ai/opencode.js";
import { SlackAdapter } from "./adapters/im/slack.js";

function parseUserList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const defaultCwd = process.env["DEFAULT_CWD"] ?? "/home/xyg/codebase";

// R11: validate DEFAULT_CWD exists and is writable
if (!existsSync(defaultCwd)) {
  console.error(`[gateway] DEFAULT_CWD does not exist: ${defaultCwd}`);
  process.exit(1);
}
try {
  accessSync(defaultCwd, constants.W_OK);
} catch {
  console.error(`[gateway] DEFAULT_CWD is not writable: ${defaultCwd}`);
  process.exit(1);
}

const router = new Router({ defaultCwd });

// ── IM adapters (enable by setting <IM>_BOT_TOKEN) ────────────────────────────

// Discord
const discordToken = process.env["DISCORD_BOT_TOKEN"];
if (discordToken) {
  if (!/^[\w.-]+$/.test(discordToken)) {
    console.error("[gateway] DISCORD_BOT_TOKEN has invalid format");
    process.exit(1);
  }
  const allowedUsers = parseUserList(process.env["DISCORD_ALLOWED_USERS"]);
  router.registerIM(
    new DiscordAdapter({ token: discordToken, allowedUsers })
  );
}

// Telegram
const telegramToken = process.env["TELEGRAM_BOT_TOKEN"];
if (telegramToken) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(telegramToken)) {
    console.error(
      "[gateway] TELEGRAM_BOT_TOKEN has invalid format (expected <id>:<token>)"
    );
    process.exit(1);
  }
  const allowedUsers = parseUserList(process.env["TELEGRAM_ALLOWED_USERS"]);
  router.registerIM(
    new TelegramAdapter({ token: telegramToken, allowedUsers })
  );
}

// Slack
const slackBotToken = process.env["SLACK_BOT_TOKEN"];
if (slackBotToken) {
  const slackAppToken = process.env["SLACK_APP_TOKEN"];
  if (!slackAppToken) {
    console.error("[gateway] SLACK_APP_TOKEN is required when SLACK_BOT_TOKEN is set");
    process.exit(1);
  }
  const allowedUsers = parseUserList(process.env["SLACK_ALLOWED_USERS"]);
  router.registerIM(
    new SlackAdapter({ botToken: slackBotToken, appToken: slackAppToken, allowedUsers })
  );
}

// Require at least one IM adapter
if (!discordToken && !telegramToken && !slackBotToken) {
  console.error(
    "[gateway] No IM adapter configured. Set DISCORD_BOT_TOKEN, TELEGRAM_BOT_TOKEN, and/or SLACK_BOT_TOKEN."
  );
  process.exit(1);
}

// ── AI adapters (multi-AI routing) ────────────────────────────────────────────
const knownBackends: Record<string, () => import("./core/types.js").AIAdapter> = {
  "claude-code": () => new ClaudeCodeAdapter(),
  "gemini": () => new GeminiAdapter(),
  "codex": () => new CodexAdapter(),
  "opencode": () => new OpenCodeAdapter(),
};

const backendsRaw = process.env["AI_BACKENDS"];
if (!backendsRaw || !backendsRaw.trim()) {
  console.error("[gateway] AI_BACKENDS is required (comma-separated, e.g. claude-code,gemini)");
  process.exit(1);
}

const backendList = backendsRaw.split(",").map((s) => s.trim()).filter(Boolean);
if (backendList.length === 0) {
  console.error("[gateway] AI_BACKENDS must contain at least one backend");
  process.exit(1);
}

const unknownBackends = backendList.filter((b) => !(b in knownBackends));
if (unknownBackends.length > 0) {
  console.error(`[gateway] Unknown AI backends: ${unknownBackends.join(", ")}. Known: ${Object.keys(knownBackends).join(", ")}`);
  process.exit(1);
}

const aiDefault = process.env["AI_DEFAULT"];
if (aiDefault && !backendList.includes(aiDefault)) {
  console.error(`[gateway] AI_DEFAULT="${aiDefault}" is not in AI_BACKENDS list`);
  process.exit(1);
}

for (const name of backendList) {
  const isDefault = aiDefault ? name === aiDefault : undefined; // first registered is default when AI_DEFAULT unset
  router.registerAI(knownBackends[name]!(), { alias: name, default: isDefault || undefined });
}

router.start().catch((err) => {
  console.error("[gateway] Failed to start:", err);
  process.exit(1);
});

function shutdown() {
  console.log("[gateway] Shutting down...");
  router.stop().then(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
