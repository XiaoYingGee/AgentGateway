import type { AIAdapter, IMAdapter, InboundMessage, SendResult } from "./types.js";
import { SessionManager } from "./session.js";
import { splitMessage } from "../utils/messages.js";
import { parseAIPrefix } from "../utils/prefix.js";
import { randomUUID } from "node:crypto";

const EDIT_THROTTLE_MS = 1500; // S2: throttle edits
const TYPING_THROTTLE_MS = 8000; // S2: typing throttle
const RATE_LIMIT_WINDOW_MS = 60_000; // R10: 1 minute window
const RATE_LIMIT_MAX = 10; // R10: max messages per window

export class Router {
  private imAdapters = new Map<string, IMAdapter>();
  private aiAdapters = new Map<string, AIAdapter>();
  private defaultAlias: string | null = null;
  private sessions: SessionManager;
  private defaultCwd: string;
  // R10: per-user rate limit — sliding window of timestamps
  private rateLimits = new Map<string, number[]>();

  constructor(opts: { defaultCwd: string }) {
    this.defaultCwd = opts.defaultCwd;
    this.sessions = new SessionManager({ baseCwd: opts.defaultCwd });
  }

  registerIM(adapter: IMAdapter): void {
    const key = `${adapter.platform}:${adapter.accountId}`;
    // M10: duplicate adapter registration throws
    if (this.imAdapters.has(key)) {
      throw new Error(`IM adapter already registered: ${key}`);
    }
    this.imAdapters.set(key, adapter);
    adapter.onMessage((msg) => this.handleMessage(msg, adapter));
  }

  registerAI(adapter: AIAdapter, opts?: { alias?: string; default?: boolean }): void {
    const alias = opts?.alias ?? adapter.name;
    if (this.aiAdapters.has(alias)) {
      throw new Error(`AI adapter already registered: ${alias}`);
    }
    this.aiAdapters.set(alias, adapter);
    // First registered or explicitly marked as default
    if (this.defaultAlias === null || opts?.default) {
      this.defaultAlias = alias;
    }
  }

  /** Return all registered AI aliases (for prefix parsing + /help) */
  getAIAliases(): string[] {
    return [...this.aiAdapters.keys()];
  }

  private resolveAI(
    sessionKey: string,
    text: string,
  ): { alias: string; prompt: string; switched: boolean } {
    const aliases = this.getAIAliases();
    const { alias: prefixAlias, prompt } = parseAIPrefix(text, aliases);

    const currentAI = this.sessions.getCurrentAI(sessionKey);

    let targetAlias: string;
    if (prefixAlias) {
      targetAlias = prefixAlias;
    } else if (currentAI) {
      targetAlias = currentAI;
    } else {
      targetAlias = this.defaultAlias!;
    }

    const switched = targetAlias !== currentAI;
    if (switched) {
      this.sessions.setCurrentAI(sessionKey, targetAlias);
    }

    return { alias: targetAlias, prompt, switched };
  }

  private async handleMessage(msg: InboundMessage, im: IMAdapter): Promise<void> {
    const { sessionKey, chatId } = msg;

    // R10: per-user rate limit
    const userKey = `${msg.platform}:${msg.userId}`;
    const now = Date.now();
    let timestamps = this.rateLimits.get(userKey);
    if (!timestamps) { timestamps = []; this.rateLimits.set(userKey, timestamps); }
    // Prune expired entries
    while (timestamps.length > 0 && timestamps[0]! <= now - RATE_LIMIT_WINDOW_MS) {
      timestamps.shift();
    }
    // P2: clean up empty entries to prevent unbounded Map growth
    if (timestamps.length === 0) this.rateLimits.delete(userKey);
    if (timestamps.length >= RATE_LIMIT_MAX) {
      await im.sendMessage({
        chatId,
        text: "Rate limit exceeded — please try again in a minute.",
        threadId: msg.threadId,
        replyToId: msg.replyToId,
      }).catch(() => {});
      return;
    }
    timestamps.push(now);
    if (!this.rateLimits.has(userKey)) this.rateLimits.set(userKey, timestamps);

    try {
      // S1: if session is busy, enqueue message instead of rejecting
      if (!this.sessions.markBusy(sessionKey)) {
        const accepted = this.sessions.enqueue(sessionKey, msg.text, {
          replyToId: msg.replyToId,
          threadId: msg.threadId,
        });
        await im.sendMessage({
          chatId,
          text: accepted
            ? "📥 Queued — will process after the current turn."
            : "⚠️ Queue full — message dropped. Please wait for the current turn to finish.",
          threadId: msg.threadId,
          replyToId: msg.replyToId,
        });
        return;
      }

      await this.processMessage(msg, im);
    } catch (err) {
      // M-6: catch mkdirSync and other early failures
      // R7: sanitize error messages — ref id for user, full stack for logs
      const refId = randomUUID().slice(0, 8);
      console.error(`[router] [${refId}] handleMessage error:`, err);
      await im.sendMessage({
        chatId,
        text: `Something went wrong (ref: ${refId}). Please try again later.`,
        threadId: msg.threadId,
        replyToId: msg.replyToId,
      }).catch(() => {});
    }
  }

  private async processMessage(msg: InboundMessage, im: IMAdapter): Promise<void> {
    const { sessionKey, chatId } = msg;
    const session = this.sessions.getOrCreate(sessionKey);

    // Resolve which AI to route to (prefix > sticky > default)
    const { alias, prompt, switched } = this.resolveAI(sessionKey, msg.text);
    const aiAdapter = this.aiAdapters.get(alias)!;

    try {
      // Send switch notice if AI changed
      if (switched) {
        await im.sendMessage({
          chatId,
          text: `🔀 已切换到 ${alias}`,
          threadId: msg.threadId,
        }).catch(() => {});
      }

      await im.sendTyping?.(chatId);

      // S2: send a placeholder message if editMessage is supported
      let placeholderResult: SendResult | undefined;
      let lastEditAt = 0;
      let lastTypingAt = 0;
      let streamedText = "";
      // R8: serialize edit calls to prevent out-of-order delivery
      let editChain = Promise.resolve();

      if (im.editMessage) {
        placeholderResult = await im.sendMessage({
          chatId,
          text: "⏳ Thinking...",
          threadId: msg.threadId,
        });
      }

      // S5: pass session-specific cwd
      const invokeCwd = session.cwd ?? this.defaultCwd;

      const result = await aiAdapter.invoke({
        prompt,
        sessionId: session.resumeIds[alias],
        cwd: invokeCwd,
        onChunk: (text) => {
          streamedText = text;
          const now = Date.now();

          // S2: edit placeholder with throttle (R2: uses SendResult, R8: serialized)
          if (im.editMessage && placeholderResult && now - lastEditAt >= EDIT_THROTTLE_MS) {
            lastEditAt = now;
            const truncated = text.length > 1900 ? text.slice(-1900) : text;
            const editFn = im.editMessage.bind(im);
            const target = placeholderResult;
            editChain = editChain.then(() => editFn(target, truncated)).catch((e) => {
              console.warn(`[router] editMessage (stream) failed:`, e);
            });
          }

          // S2: typing throttle
          if (now - lastTypingAt >= TYPING_THROTTLE_MS) {
            lastTypingAt = now;
            im.sendTyping?.(chatId).catch(() => {});
          }
        },
      });

      if (result.sessionId) {
        this.sessions.setResumeId(sessionKey, alias, result.sessionId);
      }

      // M4: sendMessage does internal splitting now (via splitAndSend)
      // Delete placeholder before sending final
      if (im.editMessage && placeholderResult) {
        // Edit placeholder to final first segment, send rest normally
        const segments = splitMessage(result.text);
        if (segments.length > 0) {
          try {
            await im.editMessage(placeholderResult, segments[0]!);
          } catch (editErr) {
            // S-1: edit failed — fallback to sendMessage so first segment isn't lost
            console.warn(`[router] editMessage (final) failed, falling back to sendMessage:`, editErr);
            await im.sendMessage({
              chatId,
              text: segments[0]!,
              threadId: msg.threadId,
            });
          }
          for (let i = 1; i < segments.length; i++) {
            await im.sendMessage({
              chatId,
              text: segments[i]!,
              threadId: msg.threadId,
            });
          }
        }
      } else {
        // M4: split internally
        const segments = splitMessage(result.text);
        for (const segment of segments) {
          await im.sendMessage({
            chatId,
            text: segment,
            threadId: msg.threadId,
            replyToId: msg.replyToId,
          });
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // R7: sanitize error — ref id for user, full details in logs only
      const refId = randomUUID().slice(0, 8);
      console.error(`[router] [${refId}] Error handling message:`, errMsg);

      // M7: if resume failed, retry as new session (drop resumeId for this alias)
      const resumeId = session.resumeIds[alias];
      if (resumeId && errMsg.includes("resume")) {
        console.log(`[router] Resume failed for ${sessionKey}/${alias}, falling back to new session`);
        delete session.resumeIds[alias];
      }

      await im.sendMessage({
        chatId,
        text: `Something went wrong (ref: ${refId}). Please try again.`,
        threadId: msg.threadId,
        replyToId: msg.replyToId,
      }).catch(() => {}); // don't let error reporting crash
    } finally {
      // R1: atomic drain loop — stay busy while queue has messages
      while (true) {
        const queued = this.sessions.drain(sessionKey);
        if (!queued) {
          this.sessions.markFree(sessionKey);
          break;
        }
        // M-1: use last queued message's replyToId/threadId
        const syntheticMsg: InboundMessage = {
          ...msg,
          text: queued.text,
          replyToId: queued.replyToId,
          threadId: queued.threadId,
        };
        try {
          await this.processMessage(syntheticMsg, im);
        } catch (err) {
          console.error(`[router] Error processing queued message:`, err);
        }
      }
    }
  }

  async start(): Promise<void> {
    // S6: assert at least one AI adapter is registered
    if (this.aiAdapters.size === 0) {
      throw new Error("Cannot start: no AI adapter registered");
    }

    for (const im of this.imAdapters.values()) {
      await im.connect();
      console.log(`[router] Connected IM adapter: ${im.platform}:${im.accountId}`);
    }
    const aliases = this.getAIAliases();
    console.log(`[router] AI adapters: ${aliases.join(", ")} (default: ${this.defaultAlias})`);
    console.log(`[router] Gateway started`);
  }

  async stop(): Promise<void> {
    // R5: graceful shutdown — stop accepting new messages first
    for (const im of this.imAdapters.values()) {
      await im.disconnect();
    }

    // R5: wait for busy sessions to complete (max 30s)
    const deadline = Date.now() + 30_000;
    while (this.sessions.hasActiveSessions() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (this.sessions.hasActiveSessions()) {
      console.warn(`[router] Shutdown timeout — some sessions still active`);
      // P3: force-kill lingering AI child processes — all adapters
      for (const ai of this.aiAdapters.values()) {
        ai.killAll?.();
      }
    }

    this.sessions.destroy();
    console.log(`[router] Gateway stopped`);
  }

  /** P5: check health of all IM adapters */
  statusCheck(): { adapter: string; healthy: boolean }[] {
    const results: { adapter: string; healthy: boolean }[] = [];
    for (const [key, im] of this.imAdapters) {
      const healthy = im.isHealthy?.() ?? true;
      results.push({ adapter: key, healthy });
      if (!healthy) console.warn(`[router] Adapter ${key} is unhealthy`);
    }
    return results;
  }
}
