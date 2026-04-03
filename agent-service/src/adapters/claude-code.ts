import { homedir } from "node:os";
import { resolve, normalize } from "node:path";
import type { AgentAdapter, SessionContext } from "../types.js";

// ---------------------------------------------------------------------------
// Path security
// ---------------------------------------------------------------------------

const HOME = homedir();

const DEFAULT_ALLOWED_PATHS: string[] = [
  HOME,
  resolve(HOME, "Workspace"),
];

const BLOCKED_PATHS: string[] = [
  resolve(HOME, ".ssh"),
  resolve(HOME, ".aws"),
  resolve(HOME, ".claude"),
  resolve(HOME, ".gnupg"),
  resolve(HOME, ".config/gh"),
];

const BLOCKED_PATTERNS: RegExp[] = [
  /\.env($|\.)/,  // .env, .env.local, .env.production, etc.
];

/**
 * Ensure `cwd` is inside one of the allowed paths and not inside
 * (or equal to) any blocked path.
 */
export function validateCwd(
  cwd: string,
  allowedPaths: string[] = DEFAULT_ALLOWED_PATHS,
): boolean {
  const normalised = normalize(resolve(cwd));

  // Must be inside at least one allowed path
  const allowed = allowedPaths.some(
    (p) => normalised === normalize(p) || normalised.startsWith(normalize(p) + "/"),
  );
  if (!allowed) return false;

  // Must not be inside any blocked path
  const blocked = BLOCKED_PATHS.some(
    (p) => normalised === normalize(p) || normalised.startsWith(normalize(p) + "/"),
  );
  if (blocked) return false;

  // Must not match blocked filename patterns
  const blockedByPattern = BLOCKED_PATTERNS.some((re) => re.test(normalised));
  if (blockedByPattern) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Claude Code Adapter
// ---------------------------------------------------------------------------

const INVOKE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code";

  async invoke(prompt: string, session: SessionContext): Promise<string> {
    if (!validateCwd(session.cwd)) {
      throw new Error(`Working directory not allowed: ${session.cwd}`);
    }

    try {
      const { query } = await import("@anthropic-ai/claude-code");

      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), INVOKE_TIMEOUT_MS);

      try {
        const conversation = query({
          prompt,
          options: {
            cwd: session.cwd,
            allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
            maxTurns: 30,
            permissionMode: "bypassPermissions",
            abortController,
          },
        });

        // Consume the async generator and collect messages
        let resultText = "";
        for await (const message of conversation) {
          // SDKResultMessage has type "result" and subtype "success" with a `result` field
          if (message.type === "result") {
            if ("result" in message && typeof message.result === "string") {
              resultText = message.result;
            }
          }
        }

        if (!resultText) {
          resultText = "(No response from Claude Code)";
        }

        // Update session bookkeeping
        session.lastActivity = Date.now();
        session.conversationHistory.push(
          { role: "user", content: prompt },
          { role: "assistant", content: resultText },
        );

        return resultText;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error during invocation";
      console.error(`[claude-code] invoke error: ${message}`);
      throw new Error(`Claude Code invocation failed: ${message}`);
    }
  }

  destroySession(_sessionId: string): void {
    // The SDK is stateless per-call; nothing to tear down.
  }
}
