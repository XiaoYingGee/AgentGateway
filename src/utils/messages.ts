const SAFE_MAX = 1900;

// M4: exported for direct use — handles splitting internally
export function splitMessage(content: string, maxLength = SAFE_MAX): string[] {
  if (content.length <= maxLength) return [content];

  const segments: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      segments.push(remaining);
      break;
    }

    const window = remaining.slice(0, maxLength);
    let splitIdx = -1;

    for (let i = maxLength - 1; i > maxLength / 2; i--) {
      if (window[i] === "\n") {
        splitIdx = i + 1;
        break;
      }
    }

    if (splitIdx <= 0) {
      const lastNl = window.lastIndexOf("\n");
      splitIdx = lastNl > maxLength / 4 ? lastNl + 1 : maxLength;
    }

    // M-3: don't split in the middle of a UTF-16 surrogate pair
    if (splitIdx > 0 && splitIdx < remaining.length) {
      const code = remaining.charCodeAt(splitIdx - 1);
      // High surrogate: 0xD800–0xDBFF — next char is the low surrogate
      if (code >= 0xD800 && code <= 0xDBFF) {
        splitIdx--;
      }
    }

    segments.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  return repairCodeBlocks(segments);
}

// M5: preserve language tags when splitting code blocks
function repairCodeBlocks(segments: string[]): string[] {
  const repaired: string[] = [];
  let openLang = ""; // tracks the language of the currently open code block

  for (let i = 0; i < segments.length; i++) {
    let seg = segments[i]!;

    // Track code block state through this segment
    const fences = seg.match(/^```\w*/gm) || [];
    let localOpen = openLang;

    for (const fence of fences) {
      if (localOpen) {
        // This fence closes the open block
        localOpen = "";
      } else {
        // This fence opens a new block; capture language tag
        localOpen = fence; // e.g. "```python" or "```"
      }
    }

    if (localOpen) {
      // Block is still open at end of segment — close it
      seg += "\n```";
      if (i + 1 < segments.length) {
        // Re-open with the same language tag in the next segment
        segments[i + 1] = localOpen + "\n" + segments[i + 1]!;
      }
      // openLang carries over for further segments (will be set by re-opened fence)
      openLang = "";
    } else {
      openLang = "";
    }

    repaired.push(seg);
  }

  return repaired;
}
