import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, normalize, sep } from "node:path";
import { execFile } from "node:child_process";
import type { AgentAdapter, SessionContext } from "../types.js";

// ---------------------------------------------------------------------------
// Path security
// ---------------------------------------------------------------------------

const HOME = homedir();

const DEFAULT_ALLOWED_PATHS: string[] = [
  HOME,
  resolve(HOME, "Workspace"),
  "D:\\Workspace",
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
  // Expand ~ to the real home directory so paths like ~/.ssh are
  // properly matched against blocked-path rules on all platforms.
  const expanded = cwd.replace(/^~(?=[/\\]|$)/, HOME);
  const normalised = normalize(resolve(expanded));

  // Must be inside at least one allowed path
  const allowed = allowedPaths.some(
    (p) => normalised === normalize(p) || normalised.startsWith(normalize(p) + sep),
  );
  if (!allowed) return false;

  // Must not be inside any blocked path
  const blocked = BLOCKED_PATHS.some(
    (p) => normalised === normalize(p) || normalised.startsWith(normalize(p) + sep),
  );
  if (blocked) return false;

  // Must not match blocked filename patterns
  const blockedByPattern = BLOCKED_PATTERNS.some((re) => re.test(normalised));
  if (blockedByPattern) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Claude Code Adapter (CLI subprocess)
// ---------------------------------------------------------------------------

const INVOKE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Find the `claude` CLI executable path.
 * On Windows, prefer the .exe from WinGet; otherwise fall back to "claude".
 */
function findClaudeCli(): string {
  if (process.platform === "win32") {
    const home = homedir();
    const candidates = [
      resolve(home, "AppData/Local/Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe"),
      resolve(home, "AppData/Roaming/npm/claude.cmd"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        console.log(`[claude-code] found CLI at: ${p}`);
        return p;
      }
    }
  }
  return "claude";
}

// Resolve once at module load so we don't stat on every invoke
const CLAUDE_CLI = findClaudeCli();

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code";

  async invoke(prompt: string, session: SessionContext): Promise<string> {
    if (!validateCwd(session.cwd)) {
      throw new Error(`Working directory not allowed: ${session.cwd}`);
    }

    return new Promise<string>((resolvePromise, rejectPromise) => {
      const args = [
        "-p", prompt,
        "--output-format", "json",
        "--max-turns", "30",
        "--allowedTools", "Read,Write,Edit,Bash,Glob,Grep",
        "--permission-mode", "bypassPermissions",
      ];

      console.log(`[claude-code] execFile: ${CLAUDE_CLI} -p "${prompt.slice(0, 60)}..." ...`);

      const child = execFile(
        CLAUDE_CLI,
        args,
        {
          cwd: session.cwd,
          env: { ...process.env },
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          timeout: INVOKE_TIMEOUT_MS,
        },
        (err, stdout, stderr) => {
          if (err) {
            const errSnippet = (stderr || err.message).slice(-500);
            console.error(`[claude-code] error: ${errSnippet}`);
            rejectPromise(new Error(`Claude Code failed: ${errSnippet}`));
            return;
          }

          try {
            const result = JSON.parse(stdout.trim());
            let resultText = "";

            if (result.type === "result" && result.result) {
              resultText = result.result;
            } else if (result.type === "result" && result.is_error) {
              resultText = `Error: Claude Code encountered an error (${result.subtype})`;
            } else {
              resultText = stdout.trim().slice(0, 1900) || "(No response from Claude Code)";
            }

            // Update session bookkeeping
            session.lastActivity = Date.now();
            session.conversationHistory.push(
              { role: "user", content: prompt },
              { role: "assistant", content: resultText },
            );

            resolvePromise(resultText);
          } catch {
            // If JSON parsing fails, return raw stdout
            const text = stdout.trim() || "(No response from Claude Code)";
            session.lastActivity = Date.now();
            resolvePromise(text.slice(0, 3800));
          }
        },
      );

      // Safety net: kill if still running after timeout (execFile has its own
      // timeout but this ensures cleanup of the child tree)
      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
        }
      }, INVOKE_TIMEOUT_MS + 5000);
      timer.unref();
    });
  }

  destroySession(_sessionId: string): void {
    // CLI mode is stateless per-call; nothing to tear down.
  }
}
