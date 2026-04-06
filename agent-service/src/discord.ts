const DISCORD_API = "https://discord.com/api/v10";
const SAFE_MAX_LENGTH = 1900; // Leave headroom below Discord's 2 000 char limit

/**
 * Edit the original deferred interaction response.
 *
 * If the content exceeds Discord's character limit it is automatically
 * split: the first segment replaces the deferred message, and subsequent
 * segments are posted as follow-ups.
 */
export async function editDeferredResponse(
  appId: string,
  token: string,
  content: string,
  _botToken?: string,
): Promise<void> {
  const segments = splitMessage(content);
  const [first, ...rest] = segments;

  if (!first) return;

  // Edit the deferred placeholder with the first segment.
  // Interaction webhook endpoints are authenticated by the interaction token
  // in the URL path — no Authorization header is needed.
  const editUrl = `${DISCORD_API}/webhooks/${appId}/${token}/messages/@original`;
  const editRes = await fetch(editUrl, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: first }),
  });

  if (!editRes.ok) {
    const text = await editRes.text();
    console.error(
      `[discord] Failed to edit deferred response: ${editRes.status} ${text}`,
    );
  }

  // Send remaining segments as follow-ups
  for (const segment of rest) {
    await sendFollowUp(appId, token, segment);
  }
}

/**
 * Send a follow-up message in the interaction thread.
 */
export async function sendFollowUp(
  appId: string,
  token: string,
  content: string,
  _botToken?: string,
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${appId}/${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(
      `[discord] Failed to send follow-up: ${res.status} ${text}`,
    );
  }
}

/**
 * Split a long message into segments that fit within Discord's character limit.
 *
 * Rules:
 *   1. Each segment is at most `maxLength` characters (default 1900).
 *   2. We never split inside a fenced code block (``` ... ```).
 *   3. We prefer splitting at newline boundaries.
 */
export function splitMessage(
  content: string,
  maxLength: number = SAFE_MAX_LENGTH,
): string[] {
  if (content.length <= maxLength) return [content];

  const segments: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      segments.push(remaining);
      break;
    }

    // Take a window of maxLength characters and find the best split point.
    const window = remaining.slice(0, maxLength);

    let splitIdx = findSplitPoint(window, maxLength);

    // If we couldn't find a good split, hard-cut at maxLength.
    if (splitIdx <= 0) {
      splitIdx = maxLength;
    }

    segments.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  // Repair any code blocks that were split across segments
  return repairCodeBlocks(segments);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the best newline-boundary split point inside `window`.
 * Avoids splitting inside fenced code blocks.
 */
function findSplitPoint(window: string, maxLength: number): number {
  // Identify open code blocks in this window
  const fences = findOpenFences(window);

  // We want to split at a newline that is NOT inside an open code block.
  // Search backwards from the end of the window.
  for (let i = maxLength - 1; i > maxLength / 2; i--) {
    if (window[i] === "\n" && !isInsideCodeBlock(i, fences)) {
      return i + 1; // include the newline in the current segment
    }
  }

  // Fallback: split at the last newline regardless of code block context
  const lastNl = window.lastIndexOf("\n");
  if (lastNl > maxLength / 4) {
    return lastNl + 1;
  }

  return -1;
}

interface FenceRange {
  open: number;
  close: number; // -1 if unclosed
}

/**
 * Locate all fenced code blocks (``` ... ```) and return their ranges.
 */
function findOpenFences(text: string): FenceRange[] {
  const ranges: FenceRange[] = [];
  const regex = /^```/gm;
  let match: RegExpExecArray | null;
  let openIdx: number | null = null;

  while ((match = regex.exec(text)) !== null) {
    if (openIdx === null) {
      openIdx = match.index;
    } else {
      ranges.push({ open: openIdx, close: match.index });
      openIdx = null;
    }
  }

  // Unclosed block
  if (openIdx !== null) {
    ranges.push({ open: openIdx, close: -1 });
  }

  return ranges;
}

function isInsideCodeBlock(pos: number, fences: FenceRange[]): boolean {
  return fences.some(
    (f) => pos > f.open && (f.close === -1 || pos < f.close),
  );
}

/**
 * If a segment ends in the middle of a code block (odd number of ```),
 * close it and re-open in the next segment so Discord renders correctly.
 */
function repairCodeBlocks(segments: string[]): string[] {
  const repaired: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    let seg = segments[i]!;

    // Count fences in the current accumulated segment
    const fenceCount = (seg.match(/^```/gm) || []).length;
    const unclosed = fenceCount % 2 !== 0;

    if (unclosed) {
      // Close the block in this segment
      seg = seg + "\n```";

      // Re-open in the next segment if there is one
      if (i + 1 < segments.length) {
        segments[i + 1] = "```\n" + segments[i + 1]!;
      }
    }

    repaired.push(seg);
  }

  return repaired;
}
