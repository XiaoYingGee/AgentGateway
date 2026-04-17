import { mkdirSync, rmSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Session } from "./types.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // M6: 24 hours
const MAX_QUEUE = 20;           // S-2: max queued messages per session
const MAX_QUEUE_CHARS = 50_000; // S-2: max total chars in queue

export class SessionManager {
  private sessions = new Map<string, Session>();
  private queues = new Map<string, Array<{ text: string; replyToId?: string; threadId?: string }>>();
  private overflow = new Set<string>();          // S-2: tracks sessions that hit queue limit
  private baseCwd: string;
  private ttlMs: number;
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(opts: { baseCwd: string; ttlMs?: number }) {
    this.baseCwd = opts.baseCwd;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

    // P1: clean orphan .sessions/ dirs on startup (memory Map is empty, all old dirs are orphans)
    this.cleanOrphanSessions();

    // M6: sweep expired sessions every 10 minutes
    this.sweepTimer = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.sweepTimer.unref();
  }

  /** P1: Remove all leftover session directories from previous runs */
  private cleanOrphanSessions(): void {
    const sessionsDir = resolve(this.baseCwd, ".sessions");
    try {
      const entries = readdirSync(sessionsDir);
      for (const entry of entries) {
        try {
          rmSync(resolve(sessionsDir, entry), { recursive: true, force: true });
        } catch (err) {
          console.warn(`[session] Failed to clean orphan directory ${entry}:`, err);
        }
      }
      if (entries.length > 0) {
        console.log(`[session] Cleaned ${entries.length} orphan session directories`);
      }
    } catch {
      // .sessions/ doesn't exist yet — nothing to clean
    }
  }

  get(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  getOrCreate(key: string): Session {
    let session = this.sessions.get(key);
    if (!session) {
      // S5: per-session isolated cwd
      // R4: UUID suffix prevents TOCTOU — new sessions never share a directory with expired ones
      const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
      const cwd = resolve(this.baseCwd, ".sessions", `${hash}-${randomUUID().slice(0, 8)}`);
      mkdirSync(cwd, { recursive: true });

      session = {
        key,
        cwd,
        busy: false,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  markBusy(key: string): boolean {
    const session = this.getOrCreate(key);
    if (session.busy) return false;
    session.busy = true;
    session.lastActiveAt = Date.now();
    return true;
  }

  markFree(key: string): void {
    const session = this.sessions.get(key);
    if (session) {
      session.busy = false;
      session.lastActiveAt = Date.now();
    }
  }

  setAiSessionId(key: string, aiSessionId: string): void {
    const session = this.getOrCreate(key);
    session.aiSessionId = aiSessionId;
  }

  delete(key: string): void {
    this.sessions.delete(key);
    this.queues.delete(key);
    this.overflow.delete(key);
  }

  // S1: per-session FIFO queue
  // S-2: returns false if queue is full (overflow)
  enqueue(key: string, text: string, meta?: { replyToId?: string; threadId?: string }): boolean {
    let q = this.queues.get(key);
    if (!q) { q = []; this.queues.set(key, q); }

    const totalChars = q.reduce((sum, t) => sum + t.text.length, 0);
    if (q.length >= MAX_QUEUE || totalChars + text.length >= MAX_QUEUE_CHARS) {
      this.overflow.add(key);
      return false;
    }
    q.push({ text, replyToId: meta?.replyToId, threadId: meta?.threadId });
    return true;
  }

  /** Drain all pending messages into a single combined prompt, or undefined if empty.
   *  M-1: returns metadata from the last queued message for correct replyToId/threadId. */
  drain(key: string): { text: string; replyToId?: string; threadId?: string } | undefined {
    const q = this.queues.get(key);
    if (!q || q.length === 0) return undefined;

    const hadOverflow = this.overflow.delete(key);
    const last = q[q.length - 1]!;

    // M-2: format as explicit instruction
    let combined: string;
    if (q.length === 1 && !hadOverflow) {
      combined = q[0]!.text;
    } else {
      combined = `The user sent ${q.length} messages while I was busy.${hadOverflow ? " Some messages were dropped due to queue overflow." : ""} Please address all:\n\n` +
        q.map((item, i) => `### Message ${i + 1}\n${item.text}`).join("\n\n");
    }
    q.length = 0;
    return { text: combined, replyToId: last.replyToId, threadId: last.threadId };
  }

  hasPending(key: string): boolean {
    const q = this.queues.get(key);
    return !!q && q.length > 0;
  }

  // M6: TTL sweep
  private sweep(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (!session.busy && now - session.lastActiveAt > this.ttlMs) {
        console.log(`[session] TTL expired: ${key}`);
        // S-3: clean up session cwd directory
        if (session.cwd) {
          rm(session.cwd, { recursive: true, force: true }).catch((err) => {
            console.warn(`[session] Failed to remove cwd ${session.cwd}:`, err);
          });
        }
        this.sessions.delete(key);
        this.queues.delete(key);
        this.overflow.delete(key);
      }
    }
  }

  /** R5: check if any session is busy */
  hasActiveSessions(): boolean {
    for (const session of this.sessions.values()) {
      if (session.busy) return true;
    }
    return false;
  }

  destroy(): void {
    clearInterval(this.sweepTimer);
  }
}
