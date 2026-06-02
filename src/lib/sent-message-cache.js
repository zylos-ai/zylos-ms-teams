const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;

const sentMessagesByConversation = new Map();

function normalizeConversationId(conversationId) {
  return String(conversationId || '').split(';')[0];
}

function pruneConversation(conversationId, ttlMs = DEFAULT_TTL_MS) {
  const map = sentMessagesByConversation.get(conversationId);
  if (!map) return;
  const cutoff = Date.now() - ttlMs;
  for (const [messageId, timestamp] of map) {
    if (timestamp <= cutoff) map.delete(messageId);
  }
  if (map.size === 0) sentMessagesByConversation.delete(conversationId);
}

export function recordSentMessage(conversationId, messageId, {
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const convId = normalizeConversationId(conversationId);
  const msgId = String(messageId || '').trim();
  if (!convId || !msgId) return false;

  pruneConversation(convId, ttlMs);
  let map = sentMessagesByConversation.get(convId);
  if (!map) {
    map = new Map();
    sentMessagesByConversation.set(convId, map);
  }
  map.set(msgId, Date.now());

  while (map.size > maxEntries) {
    const firstKey = map.keys().next().value;
    if (!firstKey) break;
    map.delete(firstKey);
  }
  return true;
}

export function isSentMessage(conversationId, messageId, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const convId = normalizeConversationId(conversationId);
  const msgId = String(messageId || '').trim();
  if (!convId || !msgId) return false;
  pruneConversation(convId, ttlMs);
  return sentMessagesByConversation.get(convId)?.has(msgId) || false;
}

export function sweepSentMessageCache(ttlMs = DEFAULT_TTL_MS) {
  for (const conversationId of sentMessagesByConversation.keys()) {
    pruneConversation(conversationId, ttlMs);
  }
}

export function clearSentMessageCache() {
  sentMessagesByConversation.clear();
}
