import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, normalize, sep } from "node:path";
import { spawn } from "node:child_process";
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
  /\.env($|\.)/, // .env, .env.local, .env.production, etc.
];

/**
 * Ensure `cwd` is inside one of the allowed paths and not inside
 * (or equal to) any blocked path.
 */
export function validateCwd(
  cwd: string,
  allowedPaths: string[] = DEFAULT_ALLOWED_PATHS,
): boolean {
  const expanded = cwd.replace(/^~(?=[/\\]|$)/, HOME);
  const normalised = normalize(resolve(expanded));

  const allowed = allowedPaths.some(
    (p) => normalised === normalize(p) || normalised.startsWith(normalize(p) + sep),
  );
  if (!allowed) return false;

  const blocked = BLOCKED_PATHS.some(
    (p) => normalised === normalize(p) || normalised.startsWith(normalize(p) + sep),
  );
  if (blocked) return false;

  const blockedByPattern = BLOCKED_PATTERNS.some((re) => re.test(normalised));
  if (blockedByPattern) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Claude Code Adapter (stream-json + session persistence)
// ---------------------------------------------------------------------------

const INVOKE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function findClaudeCli(): string {
  const home = homedir();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    candidates.push(
      resolve(home, "AppData/Local/Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe"),
      resolve(home, "AppData/Roaming/npm/claude.cmd"),
    );
  } else {
    candidates.push(
      "/usr/local/bin/claude",
      resolve(home, ".local/bin/claude"),
      resolve(home, ".npm-global/bin/claude"),
    );
    if (process.platform === "darwin") {
      candidates.push("/opt/homebrew/bin/claude");
    }
  }

  for (const p of candidates) {
    if (existsSync(p)) {
      console.log(`[claude-code] found CLI at: ${p}`);
      return p;
    }
  }
  return "claude";
}

const CLAUDE_CLI = findClaudeCli();

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code";

  async invoke(prompt: string, session: SessionContext): Promise<string> {
    if (!validateCwd(session.cwd)) {
      throw new Error(`Working directory not allowed: ${session.cwd}`);
    }

    return new Promise<string>((resolvePromise, rejectPromise) => {
      const isResume = session.conversationHistory.length > 0 && !!session.claudeSessionId;

      const args = [
        "-p", prompt,
        "--verbose",
        "--output-format", "stream-json",
        "--max-turns", "30",
        "--allowedTools", "Read,Write,Edit,Bash,Glob,Grep",
        "--permission-mode", "bypassPermissions",
      ];

      // Use session persistence: --session-id for new, --resume for continuing
      if (isResume) {
        args.push("--resume", session.claudeSessionId!);
      } else if (session.claudeSessionId) {
        args.push("--session-id", session.claudeSessionId);
      }

      console.log(`[claude-code] spawn: prompt="${prompt.slice(0, 60)}..." session=${session.claudeSessionId ?? "new"} resume=${isResume}`);

      const child = spawn(CLAUDE_CLI, args, {
        cwd: session.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
      });
      child.stdin.end();

      let resultText = "";
      let latestAssistantText = "";
      let buffer = "";
      let capturedSessionId: string | undefined;

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            // Capture session ID from init event
            if (event.type === "system" && event.session_id) {
              capturedSessionId = event.session_id;
            }

            if (event.type === "assistant") {
              const content = event.message?.content;
              if (Array.isArray(content)) {
                const texts = content
                  .filter((b: { type: string }) => b.type === "text")
                  .map((b: { text: string }) => b.text);
                if (texts.length > 0) {
                  latestAssistantText = texts.join("\n");
                }
              }
            } else if (event.type === "result") {
              resultText = event.result ?? latestAssistantText;
              if (event.session_id) {
                capturedSessionId = event.session_id;
              }
            }
          } catch {
            // Ignore unparseable lines
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg) console.error(`[claude-code] stderr: ${msg.slice(-300)}`);
      });

      child.on("close", (code) => {
        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            if (event.type === "result") {
              resultText = event.result ?? latestAssistantText;
              if (event.session_id) {
                capturedSessionId = event.session_id;
              }
            }
          } catch { /* ignore */ }
        }

        const finalText = resultText || latestAssistantText || "(No response)";

        if (code !== 0 && !finalText) {
          rejectPromise(new Error(`Claude exited with code ${code}`));
          return;
        }

        // Persist session ID for future --resume calls
        if (capturedSessionId) {
          session.claudeSessionId = capturedSessionId;
        }

        // Update session bookkeeping
        session.lastActivity = Date.now();
        session.conversationHistory.push(
          { role: "user", content: prompt },
          { role: "assistant", content: finalText },
        );

        console.log(`[claude-code] Done, ${finalText.length} chars, sessionId=${session.claudeSessionId ?? "none"}`);
        resolvePromise(finalText);
      });

      // Timeout safety net
      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
        }
      }, INVOKE_TIMEOUT_MS);
      timer.unref();
    });
  }

  destroySession(_sessionId: string): void {
    // Session state is managed by Claude CLI's persistence layer.
  }
}
