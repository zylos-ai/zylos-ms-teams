import { escapeXml } from './format.js';
import { logEntry, ensureReplay } from './context.js';

const chatHistories = new Map();

export function recordHistoryEntry(chatId, entry, config) {
  const key = String(chatId).split(';')[0];
  if (!chatHistories.has(key)) chatHistories.set(key, []);
  const history = chatHistories.get(key);

  if (entry.message_id && history.some(h => h.message_id === entry.message_id)) return;

  const normalize = t => (t || '').replace(/[*_`#\->\[\]()!]/g, '').replace(/\s+/g, ' ').trim().substring(0, 120);
  const entryNorm = normalize(entry.text);
  const entryTime = new Date(entry.timestamp).getTime();
  const recentDup = entryNorm && history.find(h =>
    normalize(h.text) === entryNorm &&
    Math.abs(new Date(h.timestamp).getTime() - entryTime) < 10000
  );
  if (recentDup) return;

  history.push(entry);
  if (!String(entry.message_id || '').startsWith('graph-')) {
    logEntry(chatId, entry);
  }

  const maxEntries = (config?.message?.context_messages || 10) * 2;
  if (history.length > maxEntries) {
    history.splice(0, history.length - maxEntries);
  }
}

export function getInMemoryContext(chatId, currentMessageId, limit) {
  const key = String(chatId).split(';')[0];
  const history = chatHistories.get(key);
  if (!history || history.length === 0) return [];

  return history
    .filter(h => h.message_id !== currentMessageId)
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''))
    .slice(-limit);
}

export function formatContextBlock(messages) {
  if (!messages || messages.length === 0) return '';
  const filtered = messages.filter(m => m.text && m.text.trim());
  if (filtered.length === 0) return '';
  const lines = filtered.map(m => `[${escapeXml(m.user_name || m.user_id)}]: ${escapeXml(m.text)}`);
  return `<group-context>\n${lines.join('\n')}\n</group-context>\n\n`;
}

export { ensureReplay };
