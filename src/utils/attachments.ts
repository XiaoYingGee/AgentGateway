import { mkdir, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

/** Unified attachment descriptor produced by IM adapters. */
export interface Attachment {
  url: string;
  filename: string;
  mimeType?: string;
  size?: number;
  /** Optional headers to include when downloading (e.g. Slack Bearer token). */
  headers?: Record<string, string>;
}

/** Result after downloading an attachment to disk. */
export interface DownloadedAttachment {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

const DEFAULT_MAX_SIZE = 25 * 1024 * 1024; // 25 MB
const DEFAULT_WHITELIST = ["image/", "text/", "application/pdf", "application/json"];
const FILENAME_MAX = 200;

export class AttachmentError extends Error {
  constructor(message: string, public readonly reason: "size" | "mime" | "download" | "io") {
    super(message);
    this.name = "AttachmentError";
  }
}

export function getMaxAttachmentSize(): number {
  const v = process.env["MAX_ATTACHMENT_SIZE"];
  if (!v) return DEFAULT_MAX_SIZE;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_SIZE;
}

export function getMimeWhitelist(): string[] {
  const v = process.env["ATTACHMENT_MIME_WHITELIST"];
  if (!v) return DEFAULT_WHITELIST;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * MIME whitelist check. Patterns ending with `/` are treated as prefixes
 * (e.g. `image/` matches `image/png`). Otherwise an exact match is required.
 * Fail-closed: empty/unknown mime → reject.
 */
export function isMimeAllowed(mime: string | undefined, whitelist: string[] = getMimeWhitelist()): boolean {
  if (!mime) return false;
  const normalized = mime.toLowerCase().split(";")[0]!.trim();
  if (!normalized) return false;
  for (const entry of whitelist) {
    const e = entry.toLowerCase();
    if (e.endsWith("/")) {
      if (normalized.startsWith(e)) return true;
    } else if (normalized === e) {
      return true;
    }
  }
  return false;
}

/** Sanitize a filename: strip path separators, parent refs, control chars, cap length. */
export function sanitizeFilename(name: string): string {
  let s = (name ?? "").toString();
  // Drop any directory component
  s = s.replace(/[\\/]+/g, "_");
  // Eliminate parent refs and leading dots
  s = s.replace(/\.\.+/g, "_");
  // Strip control chars and other risky characters
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_");
  s = s.trim().replace(/^\.+/, "");
  if (!s) s = "file";
  if (s.length > FILENAME_MAX) {
    const ext = path.extname(s).slice(0, 16);
    s = s.slice(0, FILENAME_MAX - ext.length) + ext;
  }
  return s;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

interface DownloadOptions {
  baseDir: string;
  sessionId: string;
  /** Used in tests to avoid network. */
  fetchImpl?: typeof fetch;
  /** Override env limit. */
  maxSize?: number;
  /** Override env whitelist. */
  whitelist?: string[];
}

/**
 * Download a single attachment with size + MIME enforcement.
 * Streams the body to disk so large files do not blow the heap.
 */
export async function downloadAttachment(
  att: Attachment,
  opts: DownloadOptions,
): Promise<DownloadedAttachment> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxSize = opts.maxSize ?? getMaxAttachmentSize();
  const whitelist = opts.whitelist ?? getMimeWhitelist();

  // Pre-flight: if adapter already told us size/mime, fail fast.
  if (att.size != null && att.size > maxSize) {
    throw new AttachmentError(
      `Attachment "${att.filename}" is too large (${formatBytes(att.size)} > ${formatBytes(maxSize)}).`,
      "size",
    );
  }
  if (att.mimeType && !isMimeAllowed(att.mimeType, whitelist)) {
    throw new AttachmentError(
      `Attachment "${att.filename}" has disallowed type ${att.mimeType}.`,
      "mime",
    );
  }

  let res: Response;
  try {
    res = await fetchImpl(att.url, { headers: att.headers });
  } catch (err) {
    throw new AttachmentError(
      `Failed to download "${att.filename}": ${(err as Error).message}`,
      "download",
    );
  }
  if (!res.ok) {
    throw new AttachmentError(
      `Failed to download "${att.filename}": HTTP ${res.status}`,
      "download",
    );
  }

  const headerMime = res.headers.get("content-type") ?? undefined;
  const mimeType = att.mimeType ?? headerMime ?? "application/octet-stream";
  if (!isMimeAllowed(mimeType, whitelist)) {
    throw new AttachmentError(
      `Attachment "${att.filename}" has disallowed type ${mimeType}.`,
      "mime",
    );
  }

  const headerLen = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(headerLen) && headerLen > maxSize) {
    throw new AttachmentError(
      `Attachment "${att.filename}" is too large (${formatBytes(headerLen)} > ${formatBytes(maxSize)}).`,
      "size",
    );
  }

  // Resolve target path under the per-session attachment directory
  const sessionSafe = sanitizeFilename(opts.sessionId);
  const dir = path.resolve(opts.baseDir, ".attachments", sessionSafe);
  await mkdir(dir, { recursive: true });
  const filename = `${Date.now()}-${sanitizeFilename(att.filename)}`;
  const target = path.resolve(dir, filename);
  // Defense in depth: target must stay within dir
  if (!target.startsWith(dir + path.sep)) {
    throw new AttachmentError(`Resolved path escapes attachment dir: ${target}`, "io");
  }

  if (!res.body) {
    throw new AttachmentError(`Empty response body for "${att.filename}".`, "download");
  }

  // Streaming download with running size guard
  let written = 0;
  const sizeGuard = new (await import("node:stream")).Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length;
      if (written > maxSize) {
        cb(new AttachmentError(
          `Attachment "${att.filename}" exceeds ${formatBytes(maxSize)} during download.`,
          "size",
        ));
        return;
      }
      cb(null, chunk);
    },
  });

  const out = createWriteStream(target);
  try {
    await pipeline(Readable.fromWeb(res.body as any), sizeGuard, out);
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError(
      `Failed to write "${att.filename}": ${(err as Error).message}`,
      "io",
    );
  }

  let size = written;
  if (size === 0) {
    try {
      const st = await stat(target);
      size = st.size;
    } catch { /* keep written */ }
  }

  return { path: target, filename, mimeType, size };
}

/** Format the trailer appended to AI prompts. */
export function formatAttachmentTrailer(downloads: DownloadedAttachment[]): string {
  if (downloads.length === 0) return "";
  const lines = downloads.map(
    (d) => `- ${d.path} (${d.mimeType}, ${formatBytes(d.size)})`,
  );
  return `\n\n[Attachments]\n${lines.join("\n")}`;
}
