import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager } from "../src/session";

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    manager = new SessionManager(3, 30 * 60 * 1000);
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
  });

  it("creates a new session for a new threadId", () => {
    const session = manager.getOrCreate("thread-1", "/workspace");
    expect(session.threadId).toBe("thread-1");
    expect(session.cwd).toBe("/workspace");
    expect(session.sessionId).toBeTruthy();
    expect(manager.getActiveCount()).toBe(1);
  });

  it("returns existing session for the same threadId", () => {
    const s1 = manager.getOrCreate("thread-1", "/workspace");
    const s2 = manager.getOrCreate("thread-1", "/workspace");
    expect(s1.sessionId).toBe(s2.sessionId);
    expect(manager.getActiveCount()).toBe(1);
  });

  it("throws when max sessions reached", () => {
    manager.getOrCreate("t1", "/ws");
    manager.getOrCreate("t2", "/ws");
    manager.getOrCreate("t3", "/ws");

    expect(() => manager.getOrCreate("t4", "/ws")).toThrow(
      /Max concurrent sessions reached/,
    );
  });

  it("allows new session after destroying an existing one", () => {
    manager.getOrCreate("t1", "/ws");
    manager.getOrCreate("t2", "/ws");
    manager.getOrCreate("t3", "/ws");

    manager.destroy("t1");
    expect(manager.getActiveCount()).toBe(2);

    const s = manager.getOrCreate("t4", "/ws");
    expect(s.threadId).toBe("t4");
  });

  it("cleans up idle sessions", () => {
    manager.getOrCreate("t1", "/ws");
    manager.getOrCreate("t2", "/ws");

    // Advance 31 minutes
    vi.advanceTimersByTime(31 * 60 * 1000);
    manager.cleanup();

    expect(manager.getActiveCount()).toBe(0);
  });

  it("keeps active sessions during cleanup", () => {
    const s1 = manager.getOrCreate("t1", "/ws");
    manager.getOrCreate("t2", "/ws");

    // Advance 20 minutes
    vi.advanceTimersByTime(20 * 60 * 1000);

    // Touch session t1
    s1.lastActivity = Date.now();

    // Advance another 15 minutes (t2 now 35 min idle, t1 only 15 min)
    vi.advanceTimersByTime(15 * 60 * 1000);
    manager.cleanup();

    expect(manager.getActiveCount()).toBe(1);
    expect(manager.get("t1")).toBeTruthy();
    expect(manager.get("t2")).toBeUndefined();
  });

  it("shutdown clears all sessions and stops timer", () => {
    manager.getOrCreate("t1", "/ws");
    manager.getOrCreate("t2", "/ws");

    manager.shutdown();
    expect(manager.getActiveCount()).toBe(0);
  });
});
