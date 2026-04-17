import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AIAdapter } from "../../core/types.js";

const TIMEOUT_MS = 5 * 60 * 1000;
const SIGKILL_DELAY = 5_000;

function findCodex(): string {
  const candidates = [
    "/usr/local/bin/codex",
    resolve(homedir(), ".local/bin/codex"),
    resolve(homedir(), ".npm-global/bin/codex"),
    "/usr/bin/codex",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "codex";
}

const CODEX_CLI = findCodex();

export class CodexAdapter implements AIAdapter {
  readonly name = "codex";
  readonly supportsResume = false;
  private activeChildren = new Set<ChildProcess>();

  constructor() {
    console.log(`[codex] Using CLI: ${CODEX_CLI}`);
  }

  async invoke(params: {
    prompt: string;
    sessionId?: string;
    cwd?: string;
    onChunk?: (text: string) => void;
  }): Promise<{ text: string; sessionId?: string; exitCode: number }> {
    const { prompt, cwd, onChunk } = params;

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn(); }
      };

      // codex CLI: `codex -q <prompt>` for quiet/non-interactive mode
      const args = ["-q", prompt];

      console.log(`[codex] Invoking: prompt="${prompt.slice(0, 60)}..."`);

      const child = spawn(CODEX_CLI, args, {
        cwd: cwd ?? process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end();
      this.activeChildren.add(child);

      child.on("error", (err) => {
        this.activeChildren.delete(child);
        settle(() => rejectPromise(new Error(`Failed to spawn codex: ${err.message}`)));
      });

      let stdout = "";
      let stderrTail = "";
      let aborted = false;

      child.stdout.on("data", (chunk: Buffer) => {
        if (aborted) return;
        const text = chunk.toString();
        stdout += text;
        onChunk?.(text);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const msg = chunk.toString();
        stderrTail = (stderrTail + msg).slice(-1500);
        const trimmed = msg.trim();
        if (trimmed) console.error(`[codex] stderr: ${trimmed.slice(-300)}`);
      });

      child.on("close", (code) => {
        this.activeChildren.delete(child);
        const exitCode = code ?? 1;
        const finalText = stdout.trim() || "(No response)";

        if (exitCode !== 0 && !stdout.trim()) {
          const errDetail = stderrTail.trim().split("\n").slice(-5).join("\n");
          const errMsg = errDetail
            ? `Codex exited with code ${exitCode}\nstderr: ${errDetail}`
            : `Codex exited with code ${exitCode}`;
          settle(() => rejectPromise(new Error(errMsg)));
          return;
        }

        console.log(`[codex] Done, ${finalText.length} chars`);
        settle(() => resolvePromise({
          text: finalText,
          sessionId: undefined,
          exitCode,
        }));
      });

      // Three-tier timeout: SIGTERM → SIGKILL → force-reject
      const timer = setTimeout(() => {
        if (child.exitCode !== null) return;
        console.error(`[codex] Timeout after ${TIMEOUT_MS}ms, sending SIGTERM`);
        child.kill("SIGTERM");

        const killTimer = setTimeout(() => {
          if (child.exitCode === null) {
            console.error(`[codex] SIGTERM ineffective, sending SIGKILL`);
            child.kill("SIGKILL");
          }
        }, SIGKILL_DELAY);
        killTimer.unref();

        aborted = true;
        settle(() => rejectPromise(new Error(`Codex timed out after ${TIMEOUT_MS}ms`)));
      }, TIMEOUT_MS);
      timer.unref();
    });
  }

  killAll(): void {
    for (const child of this.activeChildren) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
    if (this.activeChildren.size > 0) {
      console.log(`[codex] Sent SIGTERM to ${this.activeChildren.size} active processes`);
    }
  }
}
