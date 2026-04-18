import { mkdir, stat, unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";
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
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export class AttachmentError extends Error {
  constructor(
    message: string,
    public readonly reason: "size" | "mime" | "download" | "io" | "redirect_loop" | "download_truncated",
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** Maximum number of HTTP redirect hops we will follow when downloading. */
const MAX_REDIRECT_HOPS = 3;

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
  // Strip zero-width / RTL override / BOM-class chars
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "_");
  s = s.trim().replace(/^\.+/, "");
  // Strip trailing dots and spaces (Windows would silently trim them)
  s = s.replace(/[. ]+$/, "");
  if (!s) s = "file";
  // Windows reserved device names — prefix to avoid downstream tooling issues
  if (WINDOWS_RESERVED.test(s)) s = "_" + s;
  if (s.length > FILENAME_MAX) {
    const ext = path.extname(s).slice(0, 16);
    s = s.slice(0, FILENAME_MAX - ext.length) + ext;
  }
  return s;
}

/**
 * Hash a sessionId into a stable, filesystem-safe directory name.
 * Avoids collisions from sanitizeFilename collapsing different separators
 * (e.g. "a/b" and "a_b" used to share a directory).
 */
export function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(String(sessionId ?? "")).digest("hex").slice(0, 32);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * Return true when an IP literal sits in a private/loopback/link-local/CGN/
 * multicast/unspecified range. Used by the SSRF guard.
 */
export function isPrivateIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 0) return false;
  if (fam === 4) {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true; // malformed → treat as private
    }
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true;                       // 0.0.0.0/8 unspecified
    if (a === 10) return true;                      // 10/8
    if (a === 127) return true;                     // 127/8 loopback
    if (a === 169 && b === 254) return true;        // 169.254/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;        // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGN
    if (a >= 224 && a <= 239) return true;          // multicast
    if (a >= 240) return true;                      // reserved + broadcast
    return false;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  // fc00::/7 unique local
  const firstHextet = lower.split(":")[0] ?? "";
  if (firstHextet.length > 0) {
    const hex = parseInt(firstHextet, 16);
    if (Number.isFinite(hex) && (hex & 0xfe00) === 0xfc00) return true; // fc00::/7
    if (Number.isFinite(hex) && (hex & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  }
  // IPv4-mapped IPv6 (R3 P0): cover both forms WHATWG URL parser may produce.
  //   - dotted form:  ::ffff:127.0.0.1
  //   - hex tail form: ::ffff:7f00:1   (URL parser normalises the dotted form to this)
  //   - fully-expanded: 0:0:0:0:0:ffff:127.0.0.1
  // Decode either tail back to a v4 string and recurse so the v4 private/loopback
  // table fires for IPv4-mapped IPv6 hostnames.
  const dotted = lower.match(/^(?:0:){0,5}::?ffff:([0-9.]+)$/) || lower.match(/^::ffff:([0-9.]+)$/);
  if (dotted) return isPrivateIp(dotted[1]!);
  // Hex tail: ::ffff:HHHH:HHHH or 0:0:0:0:0:ffff:HHHH:HHHH
  const hexMapped = lower.match(/^(?:0:){0,5}:?:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) ||
                    lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateIp(v4);
    }
    return true; // malformed mapped form → treat as private (fail closed)
  }
  return false;
}

/** Redact bot-token-style fragments from a URL for safe logging. */
export function redactToken(s: string): string {
  if (!s) return s;
  return String(s).replace(/(bot)(\d+:[A-Za-z0-9_-]+)/gi, "$1<redacted>")
                  .replace(/(token=)[^&\s]+/gi, "$1<redacted>");
}

/**
 * Resolve a Telegram tg-file://<file_id> placeholder to a real download URL.
 * The bot token is taken from TELEGRAM_BOT_TOKEN env so it never appears in
 * InboundAttachment.url, prompts, or error messages bubbled to the user.
 * Throws AttachmentError("download") on any failure (errors are token-redacted).
 */
export async function resolveTelegramFileUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<string> {
  const m = /^tg-file:\/\/(.+)$/i.exec(url);
  if (!m) return url;
  const fileId = m[1]!;
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    throw new AttachmentError(
      `Telegram attachment requires TELEGRAM_BOT_TOKEN to download.`,
      "download",
    );
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const apiUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
    let res: Response;
    try {
      res = await fetchImpl(apiUrl, { signal: ctrl.signal });
    } catch (err) {
      throw new AttachmentError(
        `Telegram getFile failed: ${redactToken((err as Error).message)}`,
        "download",
      );
    }
    if (!res.ok) {
      throw new AttachmentError(`Telegram getFile failed: HTTP ${res.status}`, "download");
    }
    let body: any;
    try { body = await res.json(); } catch {
      throw new AttachmentError(`Telegram getFile returned non-JSON.`, "download");
    }
    const filePath = body?.result?.file_path;
    if (!filePath || typeof filePath !== "string") {
      throw new AttachmentError(`Telegram getFile missing file_path.`, "download");
    }
    // R3: Telegram is trusted, but encode the filePath component for hygiene
    // so a stray `..`, scheme, or whitespace in `file_path` cannot break the URL.
    // We use encodeURI (not encodeURIComponent) because filePath may legitimately
    // contain `/` separators between subdirectory segments.
    return `https://api.telegram.org/file/bot${token}/${encodeURI(filePath)}`;
  } finally {
    clearTimeout(timer);
  }
}

function allowPrivateIps(): boolean {
  return process.env["ATTACHMENT_ALLOW_PRIVATE_IPS"] === "true";
}

/**
 * Validate a URL before fetching: protocol whitelist + (unless overridden)
 * SSRF guard against private/loopback/link-local addresses.
 * Throws AttachmentError(reason: "download") on rejection so caller surfaces
 * a uniform user-facing message.
 *
 * Returns the IP addresses the host resolved to (empty when host is an IP
 * literal that's already public, or guard is disabled). Callers may use the
 * resolved IP to mitigate DNS-rebinding TOCTOU.
 */
export async function assertSafeUrl(rawUrl: string): Promise<{ addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AttachmentError(`Invalid attachment URL.`, "download");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new AttachmentError(`Disallowed URL protocol: ${url.protocol}`, "download");
  }
  if (allowPrivateIps()) return { addresses: [] };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) {
    throw new AttachmentError(`Attachment URL has no host.`, "download");
  }
  // If host is already an IP literal, check directly.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new AttachmentError(`Attachment URL resolves to a non-routable address.`, "download");
    }
    return { addresses: [host] };
  }
  // DNS lookup — reject if any resolved address is private.
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (err) {
    throw new AttachmentError(`DNS lookup failed for ${host}: ${(err as Error).message}`, "download");
  }
  if (addrs.length === 0) {
    throw new AttachmentError(`DNS lookup returned no addresses for ${host}.`, "download");
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new AttachmentError(
        `Attachment URL ${host} resolves to a non-routable address (${a.address}).`,
        "download",
      );
    }
  }
  return { addresses: addrs.map((a) => a.address) };
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
  /** Per-request timeout (ms). Defaults to ATTACHMENT_TIMEOUT_MS or 30s. */
  timeoutMs?: number;
  /** Skip SSRF guard (test-only). */
  skipUrlValidation?: boolean;
  /** Force SSRF guard even when fetchImpl is set (test-only). */
  enforceUrlValidation?: boolean;
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
  const timeoutMs = opts.timeoutMs ?? Number(process.env["ATTACHMENT_TIMEOUT_MS"] ?? 30_000);

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

  // SSRF guard — protocol whitelist + private/loopback/link-local rejection.
  // When a custom fetchImpl is supplied (test path) the URL never hits the network,
  // so we skip validation unless the caller explicitly opts in.
  const skipUrl = opts.enforceUrlValidation
    ? false
    : (opts.skipUrlValidation ?? !!opts.fetchImpl);

  // Telegram tg-file:// resolver: convert placeholder to real URL via getFile,
  // keeping the bot token out of att.url and any user-visible error path.
  let effectiveUrl = att.url;
  if (effectiveUrl.startsWith("tg-file://")) {
    effectiveUrl = await resolveTelegramFileUrl(effectiveUrl, fetchImpl);
  }

  if (!skipUrl) {
    await assertSafeUrl(effectiveUrl);
  }

  let res: Response;
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    // R3 P0-1: SSRF-safe redirect handling.
    // Use redirect: "manual" so we can re-validate every hop's Location header.
    // We bound the chain at MAX_REDIRECT_HOPS to defeat redirect loops and
    // "infinite redirect to internal" probes. The first hop was already
    // validated above; per-hop assertSafeUrl runs again in-loop for follows.
    let currentUrl = effectiveUrl;
    let hop = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        res = await fetchImpl(currentUrl, {
          headers: att.headers,
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        throw new AttachmentError(
          `Failed to download "${att.filename}": ${redactToken(msg)}`,
          "download",
        );
      }
      // 3xx with a Location header → re-validate then re-fetch (manual follow).
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) {
          throw new AttachmentError(
            `Failed to download "${att.filename}": HTTP ${res.status} without Location header`,
            "download",
          );
        }
        if (++hop > MAX_REDIRECT_HOPS) {
          throw new AttachmentError(
            `Failed to download "${att.filename}": redirect chain exceeded ${MAX_REDIRECT_HOPS} hops`,
            "redirect_loop",
          );
        }
        // Resolve Location relative to the current URL (covers absolute and relative redirects).
        let nextUrl: string;
        try { nextUrl = new URL(loc, currentUrl).toString(); }
        catch {
          throw new AttachmentError(
            `Failed to download "${att.filename}": invalid redirect Location "${loc}"`,
            "download",
          );
        }
        // R3 P1-5 (DNS rebinding TOCTOU): re-validate the redirect target every
        // hop. We still let fetch run its own DNS lookup (no IP pinning via a
        // custom dispatcher) — simpler implementation, accepted trade-off for
        // the gateway's threat model. See FIX-R3.md for details.
        if (!skipUrl) await assertSafeUrl(nextUrl);
        // Drain the 3xx body so the connection can be reused.
        try { await res.body?.cancel(); } catch { /* ignore */ }
        currentUrl = nextUrl;
        continue;
      }
      break;
    }
    if (!res.ok) {
      throw new AttachmentError(
        `Failed to download "${att.filename}": HTTP ${res.status}`,
        "download",
      );
    }

    const headerMime = (res.headers.get("content-type") ?? undefined)?.toLowerCase();
    // QA-5.2: if both adapter and server provide a MIME, BOTH must be in the whitelist.
    // The adapter's value is no longer trusted to launder a disallowed server payload.
    if (headerMime && !isMimeAllowed(headerMime, whitelist)) {
      throw new AttachmentError(
        `Attachment "${att.filename}" has disallowed type ${headerMime}.`,
        "mime",
      );
    }
    const mimeType = att.mimeType ?? headerMime ?? "application/octet-stream";
    if (!isMimeAllowed(mimeType, whitelist)) {
      throw new AttachmentError(
        `Attachment "${att.filename}" has disallowed type ${mimeType}.`,
        "mime",
      );
    }

    // R3 NR-1: distinguish "header absent" (NaN, length unknown) from
    // "Content-Length: 0" (explicit zero). `Number("") === 0` would conflate
    // them and let an empty chunked-encoded response slip through the empty-
    // body guard below.
    const headerLenRaw = res.headers.get("content-length");
    const headerLen = headerLenRaw == null ? NaN : Number(headerLenRaw);
    if (Number.isFinite(headerLen) && headerLen > maxSize) {
      throw new AttachmentError(
        `Attachment "${att.filename}" is too large (${formatBytes(headerLen)} > ${formatBytes(maxSize)}).`,
        "size",
      );
    }

    // Resolve target path under the per-session attachment directory.
    // Hash the sessionId so distinct keys never share a directory (QA-6.3).
    const sessionSafe = hashSessionId(opts.sessionId);
    const dir = path.resolve(opts.baseDir, ".attachments", sessionSafe);
    await mkdir(dir, { recursive: true });
    // Random suffix avoids ms-collision when two attachments arrive at the same Date.now() (QA-6.4).
    const filename = `${Date.now()}-${randomBytes(4).toString("hex")}-${sanitizeFilename(att.filename)}`;
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
    const sizeGuard = new Transform({
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
      // Cleanup partial file on any pipeline error
      await unlink(target).catch(() => {});
      if (err instanceof AttachmentError) throw err;
      // R3 #8: undici raises `terminated` (or socket reset) when the server
      // lies about Content-Length. Surface this as `download_truncated` so
      // callers can distinguish it from a generic write-side I/O failure.
      const errMsg = (err as Error).message ?? String(err);
      const code = (err as any)?.code ?? (err as any)?.cause?.code;
      const looksTruncated =
        code === "UND_ERR_SOCKET" ||
        /terminated|premature close|aborted|stream reset/i.test(errMsg);
      if (Number.isFinite(headerLen) && headerLen > 0 && looksTruncated) {
        throw new AttachmentError(
          `Attachment "${att.filename}" size mismatch: declared ${headerLen}B, transport terminated early.`,
          "download_truncated",
        );
      }
      throw new AttachmentError(
        `Failed to write "${att.filename}": ${errMsg}`,
        "io",
      );
    }

    // Content-Length integrity check (QA-3.3): if server declared a length, the
    // streamed body must match exactly. Otherwise an attacker (or a buggy upstream)
    // can silently truncate a file that we then hand to the AI.
    // R3 #8: standardise on `download_truncated` for declared-vs-actual size
    // mismatches so callers can branch on it.
    if (Number.isFinite(headerLen) && headerLen > 0 && written !== headerLen) {
      await unlink(target).catch(() => {});
      throw new AttachmentError(
        `Attachment "${att.filename}" size mismatch: declared ${headerLen}B, received ${written}B.`,
        "download_truncated",
      );
    }

    // Empty body without an explicit Content-Length is almost certainly an error
    // (Reviewer feedback). If the server actually said "Content-Length: 0" we honor it.
    if (written === 0 && !(Number.isFinite(headerLen) && headerLen === 0)) {
      await unlink(target).catch(() => {});
      throw new AttachmentError(
        `Empty response body for "${att.filename}".`,
        "download",
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
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Format the trailer appended to AI prompts. */
export function formatAttachmentTrailer(downloads: DownloadedAttachment[]): string {
  if (downloads.length === 0) return "";
  const lines = downloads.map(
    (d) => `- ${d.path} (${d.mimeType}, ${formatBytes(d.size)})`,
  );
  return `\n\n[Attachments]\n${lines.join("\n")}`;
}
