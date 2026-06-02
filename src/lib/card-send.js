export function parseCardMarker(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('[CARD:') || !trimmed.endsWith(']')) return null;
  const rawJson = trimmed.slice('[CARD:'.length, -1).trim();
  if (!rawJson) throw new Error('empty CARD payload');
  const content = JSON.parse(rawJson);
  return {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content,
  };
}
