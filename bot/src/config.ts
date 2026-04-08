import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

export const config = {
  botToken: requireEnv("BOT_TOKEN"),
  appId: requireEnv("BOT_APP_ID"),
  allowedUsers: (process.env["ALLOWED_USERS"] ?? "").split(",").map(s => s.trim()).filter(Boolean),
  defaultCwd: process.env["DEFAULT_CWD"] ?? "/home/xyg/codebase",
};
