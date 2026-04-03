import { randomUUID } from "node:crypto";
import type { SessionContext } from "./types.js";

const DEFAULT_MAX_SESSIONS = 5;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class SessionManager {
  private sessions = new Map<string, SessionContext>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxSessions: number;
  private readonly timeoutMs: number;

  constructor(
    maxSessions: number = DEFAULT_MAX_SESSIONS,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.maxSessions = maxSessions;
    this.timeoutMs = timeoutMs;

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);

    // Allow the Node.js process to exit even if the timer is still running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Return an existing session for the thread or create a new one.
   * Throws if the maximum concurrent session count has been reached and
   * there is no existing session for this thread.
   */
  getOrCreate(threadId: string, cwd: string): SessionContext {
    const existing = this.sessions.get(threadId);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing;
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `Max concurrent sessions reached (${this.maxSessions}). Try again later.`,
      );
    }

    const session: SessionContext = {
      sessionId: randomUUID(),
      threadId,
      cwd,
      lastActivity: Date.now(),
      conversationHistory: [],
    };

    this.sessions.set(threadId, session);
    return session;
  }

  get(threadId: string): SessionContext | undefined {
    return this.sessions.get(threadId);
  }

  destroy(threadId: string): void {
    this.sessions.delete(threadId);
  }

  /**
   * Remove sessions that have been idle longer than the configured timeout.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [threadId, session] of this.sessions) {
      if (now - session.lastActivity > this.timeoutMs) {
        this.sessions.delete(threadId);
      }
    }
  }

  getActiveCount(): number {
    return this.sessions.size;
  }

  /**
   * Gracefully tear down: stop the cleanup timer and remove all sessions.
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}
