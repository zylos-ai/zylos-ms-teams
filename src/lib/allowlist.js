import { normalize, normalizeName } from './normalize.js';

function hasGlob(value) {
  return normalize(value).includes('*') || normalize(value).includes('?');
}

export function globToRegExp(pattern) {
  const source = normalize(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i');
}

export function globMatches(pattern, value) {
  const raw = normalize(pattern);
  if (!raw) return false;
  if (raw === '*') return true;
  if (!hasGlob(raw)) {
    return normalizeName(raw) === normalizeName(value);
  }
  return globToRegExp(raw).test(normalize(value));
}

export function selectConfiguredEntry(entries = {}, conversationId = '') {
  const id = normalize(conversationId);
  const baseId = id.split(';')[0];
  if (Array.isArray(entries)) {
    for (const pattern of entries) {
      if (globMatches(pattern, id) || globMatches(pattern, baseId)) return {};
    }
    return null;
  }

  if (entries[id]) return entries[id];
  if (entries[baseId]) return entries[baseId];

  for (const [pattern, config] of Object.entries(entries)) {
    if (!hasGlob(pattern)) continue;
    if (globMatches(pattern, id) || globMatches(pattern, baseId)) return config;
  }

  return null;
}

export function isConfiguredConversation(entries = {}, conversationId = '') {
  return Boolean(selectConfiguredEntry(entries, conversationId));
}

export function allowlistMatches(allowFrom = [], { aadObjectId = '', displayName = '' } = {}, resolution = {}) {
  const aad = normalize(aadObjectId);
  const name = normalize(displayName);
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) return false;

  for (const rawEntry of allowFrom) {
    const entry = normalize(rawEntry);
    if (!entry) continue;
    if (entry === '*') return true;

    if (entry.toLowerCase().startsWith('group:')) {
      const groupName = normalize(entry.slice('group:'.length));
      const members = resolution.groups?.[normalizeName(groupName)]?.members || [];
      if (members.map(String).includes(aad)) return true;
      continue;
    }

    const resolvedUsers = resolution.users?.[normalizeName(entry)] || [];
    if (resolvedUsers.map(String).includes(aad)) return true;

    if (aad && globMatches(entry, aad)) return true;
    if (name && globMatches(entry, name)) return true;
  }

  return false;
}

export function routeAllowlistMatches(routeConfig = {}, principal = {}, resolution = {}) {
  const allowFrom = routeConfig.allowFrom || [];
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) return true;
  return allowlistMatches(allowFrom, principal, resolution);
}
