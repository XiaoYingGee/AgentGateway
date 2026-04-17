import "dotenv/config";
import { existsSync, accessSync, constants } from "node:fs";
import { Router } from "./core/router.js";
import { DiscordAdapter } from "./adapters/im/discord.js";
import { TelegramAdapter } from "./adapters/im/telegram.js";
import { ClaudeCodeAdapter } from "./adapters/ai/claude-code.js";
import { GeminiAdapter } from "./adapters/ai/gemini.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[gateway] Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

const botToken = requireEnv("BOT_TOKEN");

// R11: validate Discord token format
if (!/^[\w.-]+$/.test(botToken)) {
  console.error("[gateway] BOT_TOKEN has invalid format");
  process.exit(1);
}

const allowedUsers = (process.env["ALLOWED_USERS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
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

router.registerIM(
  new DiscordAdapter({ token: botToken, allowedUsers })
);
const aiBackend = process.env["AI_BACKEND"] ?? "claude-code";
if (aiBackend === "gemini") {
  router.registerAI(new GeminiAdapter());
} else {
  router.registerAI(new ClaudeCodeAdapter());
}

// Optional: Telegram adapter (enabled when TELEGRAM_BOT_TOKEN is set)
const telegramToken = process.env["TELEGRAM_BOT_TOKEN"];
if (telegramToken) {
  // R11: validate Telegram token format (numeric:alphanumeric)
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(telegramToken)) {
    console.error("[gateway] TELEGRAM_BOT_TOKEN has invalid format (expected <id>:<token>)");
    process.exit(1);
  }
  const telegramAllowedUsers = (process.env["TELEGRAM_ALLOWED_USERS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  router.registerIM(
    new TelegramAdapter({ token: telegramToken, allowedUsers: telegramAllowedUsers })
  );
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
