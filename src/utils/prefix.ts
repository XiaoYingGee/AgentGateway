/**
 * Parse AI routing prefix from user message.
 * e.g. "/claude help me debug" → { alias: "claude", prompt: "help me debug" }
 */
export function parseAIPrefix(
  text: string,
  aliases: string[],
): { alias?: string; prompt: string } {
  const m = text.match(/^\s*\/([a-z][a-z0-9-]*)\s+([\s\S]*)$/i);
  if (!m) return { prompt: text };
  const alias = m[1]!.toLowerCase();
  if (!aliases.includes(alias)) return { prompt: text }; // unknown prefix → treat as normal message
  return { alias, prompt: m[2]! };
}
