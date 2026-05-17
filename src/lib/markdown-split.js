const DEFAULT_MAX_LENGTH = 4000;

function isInsideCodeBlock(text, position) {
  let inFenced = false;
  let i = 0;
  while (i < position) {
    if (text.startsWith('```', i)) {
      inFenced = !inFenced;
      i += 3;
    } else {
      i++;
    }
  }
  return inFenced;
}

function findSplitPoint(text, maxPos) {
  if (isInsideCodeBlock(text, maxPos)) {
    const lastFence = text.lastIndexOf('```', maxPos);
    if (lastFence > maxPos * 0.3) return lastFence;
  }

  const lastPara = text.lastIndexOf('\n\n', maxPos);
  if (lastPara > maxPos * 0.3) return lastPara + 1;

  const lastLine = text.lastIndexOf('\n', maxPos);
  if (lastLine > maxPos * 0.3) return lastLine;

  const lastSpace = text.lastIndexOf(' ', maxPos);
  if (lastSpace > maxPos * 0.3) return lastSpace;

  return maxPos;
}

export function splitMarkdownMessage(text, maxLength = DEFAULT_MAX_LENGTH) {
  if (!text) return [''];
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let pos = 0;
  let carriedFence = false;

  while (pos < text.length) {
    const prefix = carriedFence ? '```\n' : '';
    const available = maxLength - prefix.length - (carriedFence ? 4 : 0);

    if (prefix.length + (text.length - pos) <= maxLength) {
      const chunk = (prefix + text.substring(pos)).trim();
      if (chunk.length > 0) chunks.push(chunk);
      break;
    }

    let breakAt = Math.min(pos + available, text.length);
    breakAt = findSplitPoint(text, breakAt);

    if (breakAt <= pos) breakAt = pos + Math.max(1, available);

    const content = text.substring(pos, breakAt);
    const inCodeBlock = isInsideCodeBlock(text, breakAt);

    let chunk = prefix + content;
    if (inCodeBlock) chunk += '\n```';
    chunk = chunk.trim();
    if (chunk.length > 0) chunks.push(chunk);

    carriedFence = inCodeBlock;
    pos = breakAt;
    while (pos < text.length && text[pos] === '\n') pos++;
  }

  return chunks.length > 0 ? chunks : [''];
}
