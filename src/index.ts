import "dotenv/config";
import { existsSync, accessSync, constants } from "node:fs";
import { Router } from "./core/router.js";
import { DiscordAdapter } from "./adapters/im/discord.js";
import { TelegramAdapter } from "./adapters/im/telegram.js";
import { ClaudeCodeAdapter } from "./adapters/ai/claude-code.js";
import { GeminiAdapter } from "./adapters/ai/gemini.js";

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

// Require at least one IM adapter
if (!discordToken && !telegramToken) {
  console.error(
    "[gateway] No IM adapter configured. Set DISCORD_BOT_TOKEN and/or TELEGRAM_BOT_TOKEN."
  );
  process.exit(1);
}

// ── AI adapter ────────────────────────────────────────────────────────────────
const aiBackend = process.env["AI_BACKEND"] ?? "claude-code";
if (aiBackend === "gemini") {
  router.registerAI(new GeminiAdapter());
} else {
  router.registerAI(new ClaudeCodeAdapter());
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
