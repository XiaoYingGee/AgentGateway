/**
 * Discord Slash Command Registration Script
 *
 * Usage:
 *   npx tsx scripts/register-commands.ts
 *
 * Required environment variables:
 *   DISCORD_APP_ID     - Discord Application ID
 *   DISCORD_BOT_TOKEN  - Discord Bot Token
 *
 * Optional:
 *   GUILD_ID           - Register commands to a specific guild (instant, for testing)
 *                        If not set, registers globally (takes up to 1 hour to propagate)
 */

const DISCORD_API = "https://discord.com/api/v10";

const commands = [
  {
    name: "claude",
    description: "Send a prompt to Claude Code agent",
    options: [
      {
        name: "prompt",
        description: "The prompt to send to Claude",
        type: 3, // STRING
        required: true,
      },
      {
        name: "cwd",
        description: "Working directory for Claude Code (default: ~/Workspace)",
        type: 3, // STRING
        required: false,
      },
    ],
  },
];

async function registerCommands() {
  const appId = process.env.DISCORD_APP_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.GUILD_ID;

  if (!appId || !botToken) {
    console.error("Error: DISCORD_APP_ID and DISCORD_BOT_TOKEN are required");
    process.exit(1);
  }

  const url = guildId
    ? `${DISCORD_API}/applications/${appId}/guilds/${guildId}/commands`
    : `${DISCORD_API}/applications/${appId}/commands`;

  const scope = guildId ? `guild ${guildId}` : "global";
  console.log(`Registering ${commands.length} command(s) (${scope})...`);

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${botToken}`,
    },
    body: JSON.stringify(commands),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Failed to register commands: ${response.status} ${error}`);
    process.exit(1);
  }

  const result = await response.json();
  console.log(`Successfully registered ${(result as any[]).length} command(s):`);
  for (const cmd of result as any[]) {
    console.log(`  /${cmd.name} (id: ${cmd.id})`);
  }
}

registerCommands().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
