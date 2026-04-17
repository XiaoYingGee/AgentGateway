import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AIAdapter } from "../../core/types.js";

const TIMEOUT_MS = 5 * 60 * 1000;
const SIGKILL_DELAY = 5_000;

function findGemini(): string {
  const candidates = [
    "/usr/local/bin/gemini",
    resolve(homedir(), ".local/bin/gemini"),
    resolve(homedir(), ".npm-global/bin/gemini"),
    "/usr/bin/gemini",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "gemini";
}

const GEMINI_CLI = findGemini();

export class GeminiAdapter implements AIAdapter {
  readonly name = "gemini";
  readonly supportsResume = false;

  constructor() {
    console.log(`[gemini] Using CLI: ${GEMINI_CLI}`);
  }

  async invoke(params: {
    prompt: string;
    sessionId?: string;
    cwd?: string;
    onChunk?: (text: string) => void;
  }): Promise<{ text: string; sessionId?: string; exitCode: number }> {
    const { prompt, cwd, onChunk } = params;
    // sessionId ignored — Gemini CLI does not support --resume

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn(); }
      };

      const args = [prompt];

      console.log(`[gemini] Invoking: prompt="${prompt.slice(0, 60)}..."`);

      const child = spawn(GEMINI_CLI, args, {
        cwd: cwd ?? process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end();

      // Handle spawn failures
      child.on("error", (err) => {
        settle(() => rejectPromise(new Error(`Failed to spawn gemini: ${err.message}`)));
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
        if (trimmed) console.error(`[gemini] stderr: ${trimmed.slice(-300)}`);
      });

      child.on("close", (code) => {
        const exitCode = code ?? 1;
        const finalText = stdout.trim() || "(No response)";

        if (exitCode !== 0 && !stdout.trim()) {
          const errDetail = stderrTail.trim().split("\n").slice(-5).join("\n");
          const errMsg = errDetail
            ? `Gemini exited with code ${exitCode}\nstderr: ${errDetail}`
            : `Gemini exited with code ${exitCode}`;
          settle(() => rejectPromise(new Error(errMsg)));
          return;
        }

        console.log(`[gemini] Done, ${finalText.length} chars`);
        settle(() => resolvePromise({
          text: finalText,
          sessionId: undefined,
          exitCode,
        }));
      });

      // Three-tier timeout: SIGTERM → SIGKILL → force-reject
      const timer = setTimeout(() => {
        if (child.exitCode !== null) return;
        console.error(`[gemini] Timeout after ${TIMEOUT_MS}ms, sending SIGTERM`);
        child.kill("SIGTERM");

        const killTimer = setTimeout(() => {
          if (child.exitCode === null) {
            console.error(`[gemini] SIGTERM ineffective, sending SIGKILL`);
            child.kill("SIGKILL");
          }
        }, SIGKILL_DELAY);
        killTimer.unref();

        aborted = true;
        settle(() => rejectPromise(new Error(`Gemini timed out after ${TIMEOUT_MS}ms`)));
      }, TIMEOUT_MS);
      timer.unref();
    });
  }
}
