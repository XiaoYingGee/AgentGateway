import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AIAdapter } from "../../core/types.js";

const TIMEOUT_MS = 5 * 60 * 1000;
const SIGKILL_DELAY = 5_000;

function findClaude(): string {
  const candidates = [
    "/usr/local/bin/claude",
    resolve(homedir(), ".local/bin/claude"),
    resolve(homedir(), ".npm-global/bin/claude"),
    "/usr/bin/claude",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "claude";
}

const CLAUDE_CLI = findClaude();

export class ClaudeCodeAdapter implements AIAdapter {
  readonly name = "claude-code";
  readonly supportsResume = true;
  // P3: track active child processes for shutdown cleanup
  private activeChildren = new Set<ChildProcess>();

  constructor() {
    console.log(`[claude-code] Using CLI: ${CLAUDE_CLI}`);
  }

  /** Ensure a cwd directory exists, return it */
  static ensureCwd(dir: string): string {
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async invoke(params: {
    prompt: string;
    sessionId?: string;
    cwd?: string;
    onChunk?: (text: string) => void;
  }): Promise<{ text: string; sessionId?: string; exitCode: number }> {
    const { prompt, sessionId, cwd, onChunk } = params;

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn(); }
      };

      // R6: restrict tools — Bash only if CLAUDE_ALLOW_BASH=true
      const allowBash = process.env["CLAUDE_ALLOW_BASH"] === "true";
      const allowedTools = allowBash
        ? "Read,Write,Edit,Bash,Glob,Grep"
        : "Read,Write,Edit,Glob,Grep";

      const args = [
        "-p", prompt,
        "--verbose",
        "--output-format", "stream-json",
        "--max-turns", "30",
        "--allowedTools", allowedTools,
        "--disallowedTools", "AskUserQuestion,EnterPlanMode,ExitPlanMode",
        "--permission-mode", "bypassPermissions",
      ];

      if (sessionId) {
        args.push("--resume", sessionId);
      }

      console.log(`[claude-code] Invoking: prompt="${prompt.slice(0, 60)}..." session=${sessionId ?? "new"}`);

      const child = spawn(CLAUDE_CLI, args, {
        cwd: cwd ?? process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
      });
      child.stdin.end();
      this.activeChildren.add(child);

      // S4: handle spawn failures
      child.on("error", (err) => {
        settle(() => rejectPromise(new Error(`Failed to spawn claude: ${err.message}`)));
      });

      let resultText = "";
      let latestAssistantText = "";
      let buffer = "";
      let capturedSessionId: string | undefined;
      let stderrTail = "";
      // M8: track stream-json errors
      let streamErrors: string[] = [];
      // L-3: abort flag — set after timeout reject, short-circuits onChunk
      let aborted = false;

      child.stdout.on("data", (chunk: Buffer) => {
        if (aborted) return; // L-3: skip processing after timeout
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            if (event.type === "system" && event.session_id) {
              capturedSessionId = event.session_id;
            }

            // M8: stream-json error events
            if (event.type === "error") {
              const errMsg = event.error?.message ?? event.message ?? JSON.stringify(event);
              streamErrors.push(errMsg);
            }

            if (event.type === "assistant") {
              const content = event.message?.content;
              if (Array.isArray(content)) {
                const texts = content
                  .filter((b: { type: string }) => b.type === "text")
                  .map((b: { text: string }) => b.text);
                if (texts.length > 0) {
                  latestAssistantText = texts.join("\n");
                  onChunk?.(latestAssistantText);
                }
              }
            } else if (event.type === "result") {
              // M8: result.is_error
              if (event.is_error) {
                streamErrors.push(event.result ?? "unknown result error");
              }
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
        const msg = chunk.toString();
        stderrTail = (stderrTail + msg).slice(-1500);
        const trimmed = msg.trim();
        if (trimmed) console.error(`[claude-code] stderr: ${trimmed.slice(-300)}`);
      });

      child.on("close", (code) => {
        this.activeChildren.delete(child);
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            if (event.type === "result") {
              if (event.is_error) {
                streamErrors.push(event.result ?? "unknown result error");
              }
              resultText = event.result ?? latestAssistantText;
              if (event.session_id) {
                capturedSessionId = event.session_id;
              }
            }
          } catch { /* ignore */ }
        }

        const finalText = resultText || latestAssistantText || "(No response)";
        const exitCode = code ?? 1;

        // M9: append stderr tail on error
        if (exitCode !== 0 && !resultText) {
          const errDetail = stderrTail.trim().split("\n").slice(-5).join("\n");
          const errMsg = streamErrors.length > 0
            ? streamErrors.join("; ")
            : `Claude exited with code ${exitCode}`;
          const full = errDetail ? `${errMsg}\nstderr: ${errDetail}` : errMsg;
          settle(() => rejectPromise(new Error(full)));
          return;
        }

        if (capturedSessionId) {
          console.log(`[claude-code] Session: ${capturedSessionId}`);
        }

        console.log(`[claude-code] Done, ${finalText.length} chars`);
        settle(() => resolvePromise({
          text: finalText,
          sessionId: capturedSessionId,
          exitCode,
        }));
      });

      // S4: Three-tier timeout — SIGTERM, then SIGKILL, then force-reject
      const timer = setTimeout(() => {
        if (child.exitCode !== null) return;
        console.error(`[claude-code] Timeout after ${TIMEOUT_MS}ms, sending SIGTERM`);
        child.kill("SIGTERM");

        // Tier 2: SIGKILL after 5s
        const killTimer = setTimeout(() => {
          if (child.exitCode === null) {
            console.error(`[claude-code] SIGTERM ineffective, sending SIGKILL`);
            child.kill("SIGKILL");
          }
        }, SIGKILL_DELAY);
        killTimer.unref();

        // Tier 3: reject immediately (don't wait for close)
        aborted = true; // L-3
        settle(() => rejectPromise(new Error(`Claude timed out after ${TIMEOUT_MS}ms`)));
      }, TIMEOUT_MS);
      timer.unref();
    });
  }

  /** P3: kill all active child processes on shutdown */
  killAll(): void {
    for (const child of this.activeChildren) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
    if (this.activeChildren.size > 0) {
      console.log(`[claude-code] Sent SIGTERM to ${this.activeChildren.size} active processes`);
    }
  }
}
