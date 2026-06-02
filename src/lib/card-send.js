export function parseCardMarker(text) {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(/^\[CARD:([\s\S]+)\]$/);
  if (!match) return null;
  const rawJson = match[1].trim();
  if (!rawJson) throw new Error('empty CARD payload');
  const content = JSON.parse(rawJson);
  return {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content,
  };
}
