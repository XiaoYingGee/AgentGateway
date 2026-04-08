const SAFE_MAX = 1900;

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

    // Try to split at a newline in the back half
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

    segments.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  return repairCodeBlocks(segments);
}

function repairCodeBlocks(segments: string[]): string[] {
  const repaired: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    let seg = segments[i]!;
    const fenceCount = (seg.match(/^```/gm) || []).length;

    if (fenceCount % 2 !== 0) {
      seg += "\n```";
      if (i + 1 < segments.length) {
        segments[i + 1] = "```\n" + segments[i + 1]!;
      }
    }

    repaired.push(seg);
  }

  return repaired;
}
