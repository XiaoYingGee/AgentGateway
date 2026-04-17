/**
 * Parse a gateway command from user message.
 * Commands must start with / (e.g. /help).
 * Returns the command name if matched, or undefined.
 */
export function parseCommand(text: string): string | undefined {
  const m = text.match(/^\s*\/(help)\s*$/i);
  return m ? m[1]!.toLowerCase() : undefined;
}
