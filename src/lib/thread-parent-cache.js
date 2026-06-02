const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 100;

const parentCache = new Map();
const injectedParents = new Map();

function normalizeId(value) {
  return String(value || '').trim();
}

function cacheKey(teamId, channelId, messageId) {
  return [teamId, channelId, messageId].map(normalizeId).join(':');
}

function injectionKey(conversationId, rootMessageId) {
  const convId = normalizeId(conversationId).split(';')[0];
  const rootId = normalizeId(rootMessageId) || normalizeId(conversationId).match(/;messageid=([^;]+)/)?.[1] || '';
  if (!convId || !rootId) return '';
  return `${convId}:${rootId}`;
}

function pruneCache({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const cutoff = Date.now() - ttlMs;
  for (const [key, entry] of parentCache) {
    if (entry.timestamp <= cutoff) parentCache.delete(key);
  }
  for (const [key, timestamp] of injectedParents) {
    if (timestamp <= cutoff) injectedParents.delete(key);
  }
  while (parentCache.size > maxEntries) {
    const firstKey = parentCache.keys().next().value;
    if (!firstKey) break;
    parentCache.delete(firstKey);
  }
  while (injectedParents.size > maxEntries) {
    const firstKey = injectedParents.keys().next().value;
    if (!firstKey) break;
    injectedParents.delete(firstKey);
  }
}

export function shouldInjectThreadParent(conversationId, rootMessageId, { ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const key = injectionKey(conversationId, rootMessageId);
  pruneCache({ ttlMs, maxEntries });
  return Boolean(key) && !injectedParents.has(key);
}

export function markThreadParentInjected(conversationId, rootMessageId) {
  const key = injectionKey(conversationId, rootMessageId);
  if (!key) return false;
  injectedParents.set(key, Date.now());
  return true;
}

export async function getCachedThreadParent(teamId, channelId, messageId, fetcher, {
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const key = cacheKey(teamId, channelId, messageId);
  if (!key || key === '::') return null;
  pruneCache({ ttlMs, maxEntries });

  const cached = parentCache.get(key);
  if (cached && cached.timestamp > Date.now() - ttlMs) {
    return cached.value;
  }

  const value = await fetcher(teamId, channelId, messageId);
  if (!value) return value;
  parentCache.set(key, { value, timestamp: Date.now() });
  return value;
}

export function clearThreadParentCache() {
  parentCache.clear();
  injectedParents.clear();
}
