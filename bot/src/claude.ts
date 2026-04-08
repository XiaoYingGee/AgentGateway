import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const TIMEOUT_MS = 5 * 60 * 1000;

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
console.log(`[claude] Using CLI: ${CLAUDE_CLI}`);

export interface HistoryMessage {
  author: string;
  content: string;
  isBot: boolean;
}

/**
 * Invoke Claude Code CLI with streaming output.
 * onUpdate is called with accumulated text as it streams in.
 */
export async function invokeClaude(
  prompt: string,
  history: HistoryMessage[],
  cwd: string,
  onUpdate?: (text: string) => void,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let fullPrompt = prompt;
    if (history.length > 0) {
      const ctx = history
        .map((m) => `[${m.isBot ? "Bot" : "User"} ${m.author}]: ${m.content}`)
        .join("\n");
      fullPrompt = `Here is the conversation history in this channel/thread:\n${ctx}\n\nNew request: ${prompt}`;
    }

    const args = [
      "-p", fullPrompt,
      "--verbose",
      "--output-format", "stream-json",
      "--max-turns", "30",
      "--allowedTools", "Read,Write,Edit,Bash,Glob,Grep",
      "--disallowedTools", "AskUserQuestion,EnterPlanMode,ExitPlanMode",
      "--permission-mode", "bypassPermissions",
    ];

    console.log(`[claude] Invoking (stream): prompt="${prompt.slice(0, 60)}..." history=${history.length} msgs`);

    const child = spawn(CLAUDE_CLI, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
    });
    child.stdin.end();

    let resultText = "";
    let latestAssistantText = "";
    let buffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === "assistant") {
            // Extract text from content blocks
            const content = event.message?.content;
            if (Array.isArray(content)) {
              const texts = content
                .filter((b: { type: string }) => b.type === "text")
                .map((b: { text: string }) => b.text);
              if (texts.length > 0) {
                latestAssistantText = texts.join("\n");
                onUpdate?.(latestAssistantText);
              }
            }
          } else if (event.type === "result") {
            resultText = event.result ?? latestAssistantText;
          }
        } catch {
          // Ignore unparseable lines
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error(`[claude] stderr: ${msg.slice(-300)}`);
    });

    child.on("close", (code) => {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "result") {
            resultText = event.result ?? latestAssistantText;
          }
        } catch { /* ignore */ }
      }

      const finalText = resultText || latestAssistantText || "(No response)";
      if (code !== 0 && !finalText) {
        rejectPromise(new Error(`Claude exited with code ${code}`));
        return;
      }
      console.log(`[claude] Done, ${finalText.length} chars, result=${JSON.stringify(resultText.slice(0, 100))}, assistant=${JSON.stringify(latestAssistantText.slice(0, 100))}`);
      resolvePromise(finalText);
    });

    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    }, TIMEOUT_MS).unref();
  });
}
