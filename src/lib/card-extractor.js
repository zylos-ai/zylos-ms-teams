import { htmlToMarkdown } from './html.js';

const ADAPTIVE_CARD = 'application/vnd.microsoft.card.adaptive';
const HERO_CARD = 'application/vnd.microsoft.card.hero';
const THUMBNAIL_CARD = 'application/vnd.microsoft.card.thumbnail';

function asObject(content) {
  if (!content) return null;
  if (typeof content === 'object') return content;
  try { return JSON.parse(content); } catch { return null; }
}

function addLine(lines, value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text) lines.push(htmlToMarkdown(text));
}

function walkAdaptiveNode(node, lines) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walkAdaptiveNode(item, lines);
    return;
  }
  if (typeof node !== 'object') return;

  switch (node.type) {
    case 'TextBlock':
    case 'RichTextBlock':
      addLine(lines, node.text);
      break;
    case 'FactSet':
      for (const fact of node.facts || []) {
        const title = String(fact.title || '').trim();
        const value = String(fact.value || '').trim();
        if (title || value) lines.push(`${title}: ${value}`.trim());
      }
      break;
    case 'Input.Text':
    case 'Input.Number':
    case 'Input.Date':
    case 'Input.Time':
    case 'Input.Toggle':
    case 'Input.ChoiceSet':
      addLine(lines, [node.label || node.id, node.value].filter(Boolean).join(': '));
      break;
    case 'Image':
      addLine(lines, node.altText);
      break;
    default:
      break;
  }

  walkAdaptiveNode(node.body, lines);
  walkAdaptiveNode(node.items, lines);
  walkAdaptiveNode(node.columns, lines);
  walkAdaptiveNode(node.facts, lines);
}

function extractAdaptiveCard(card) {
  const lines = [];
  walkAdaptiveNode(card.body || card, lines);
  const title = lines[0] || card.title || 'Adaptive Card';
  const content = lines.join('\n').trim();
  return content ? `[Adaptive Card: ${title}]\n${content}` : '';
}

function extractSimpleCard(card, label) {
  const lines = [];
  addLine(lines, card.title);
  addLine(lines, card.subtitle);
  addLine(lines, card.text);
  for (const button of card.buttons || []) {
    addLine(lines, [button.title, button.value || button.type].filter(Boolean).join(': '));
  }
  if (lines.length === 0) return '';
  return `[${label}: ${lines[0]}]\n${lines.join('\n')}`;
}

export function extractCardText(attachments = []) {
  const blocks = [];
  for (const attachment of attachments || []) {
    const contentType = attachment.contentType || '';
    const card = asObject(attachment.content);
    if (!card) continue;
    if (contentType === ADAPTIVE_CARD) {
      const block = extractAdaptiveCard(card);
      if (block) blocks.push(block);
    } else if (contentType === HERO_CARD || contentType === THUMBNAIL_CARD) {
      const block = extractSimpleCard(card, contentType === HERO_CARD ? 'Hero Card' : 'Thumbnail Card');
      if (block) blocks.push(block);
    }
  }
  return blocks.join('\n\n');
}

export function hasCardAttachments(attachments = []) {
  return (attachments || []).some(att =>
    [ADAPTIVE_CARD, HERO_CARD, THUMBNAIL_CARD].includes(att.contentType || '')
  );
}
