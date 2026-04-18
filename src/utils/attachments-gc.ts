import { readdir, stat, unlink, rm } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TTL_HOURS = 24;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h

export function getAttachmentTtlMs(): number {
  const v = process.env["ATTACHMENT_TTL_HOURS"];
  if (v == null) return DEFAULT_TTL_HOURS * 60 * 60 * 1000;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TTL_HOURS * 60 * 60 * 1000;
  return n * 60 * 60 * 1000;
}

/**
 * Sweep .attachments/ subtree under baseDir, removing files older than ttlMs.
 * Empty per-session directories are removed afterwards.
 * TTL of 0 disables the sweep (returns 0 immediately).
 *
 * R3 P0-3: callers can pass `activeSessionDirs` — a Set of session-dir names
 * (the sha256-prefixed string returned by `hashSessionId`) that are currently
 * in use. Files inside an active session dir are NEVER removed even if their
 * mtime is past the TTL, so an in-progress conversation cannot lose its
 * attachments mid-turn. Pass an empty/undefined set for backward compatibility.
 *
 * Returns the number of files removed.
 */
export async function sweepAttachments(
  baseDir: string,
  ttlMs: number = getAttachmentTtlMs(),
  activeSessionDirs?: ReadonlySet<string>,
): Promise<number> {
  if (ttlMs <= 0) return 0;
  const root = path.resolve(baseDir, ".attachments");
  let sessions: string[];
  try {
    sessions = await readdir(root);
  } catch {
    return 0; // .attachments/ doesn't exist yet
  }
  const cutoff = Date.now() - ttlMs;
  let removed = 0;
  for (const session of sessions) {
    const sessionDir = path.join(root, session);
    // R3 P0-3: skip active session dirs entirely. We don't even attempt to
    // unlink files here, so a long-running conversation keeps its attachments.
    if (activeSessionDirs && activeSessionDirs.has(session)) continue;
    let files: string[];
    try {
      files = await readdir(sessionDir);
    } catch {
      continue;
    }
    let remaining = files.length;
    for (const f of files) {
      const p = path.join(sessionDir, f);
      try {
        const st = await stat(p);
        if (st.isFile() && st.mtimeMs < cutoff) {
          await unlink(p);
          removed++;
          remaining--;
        }
      } catch {
        // skip on any error
      }
    }
    if (remaining === 0) {
      // Best-effort empty-dir removal
      await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return removed;
}

/**
 * Schedule periodic sweeps of the .attachments/ directory.
 * Returns a stop() function; the timer is unrefed so it never blocks shutdown.
 * Runs once immediately so startup-leftover files are reclaimed.
 *
 * R3 P0-3: pass `getActiveSessionDirs` so the sweeper asks the Router which
 * sessions are currently active each tick (live state, not snapshot).
 */
export function startAttachmentGc(opts: {
  baseDir: string;
  intervalMs?: number;
  ttlMs?: number;
  getActiveSessionDirs?: () => ReadonlySet<string>;
}): () => void {
  const ttlMs = opts.ttlMs ?? getAttachmentTtlMs();
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (ttlMs <= 0) return () => {};
  const runOnce = () => sweepAttachments(opts.baseDir, ttlMs, opts.getActiveSessionDirs?.()).catch((err) => {
    console.warn(`[attachments-gc] sweep failed:`, err);
  });
  // Initial sweep (fire-and-forget; errors logged)
  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
