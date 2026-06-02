import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/ms-teams');
export const ALLOWLIST_RESOLUTION_FILE = path.join(DATA_DIR, 'allowlist-resolution.json');
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

function normalize(value) {
  return String(value || '').trim();
}

function key(value) {
  return normalize(value).toLowerCase();
}

function looksLikeDirectId(value) {
  const raw = normalize(value);
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(raw)
    || raw.startsWith('29:')
    || raw.startsWith('8:')
    || raw.startsWith('a:')
    || raw.startsWith('19:');
}

function collectAllowEntries(config) {
  const entries = new Set();
  for (const value of config.dmAllowFrom || []) entries.add(String(value));
  for (const cfg of Object.values(config.groups || {}).filter(value => value && typeof value === 'object')) {
    for (const value of cfg.allowFrom || []) entries.add(String(value));
  }
  for (const cfg of Object.values(config.channels || {}).filter(value => value && typeof value === 'object')) {
    for (const value of cfg.allowFrom || []) entries.add(String(value));
  }
  return [...entries].map(normalize).filter(Boolean);
}

export function loadAllowlistResolution(filePath = ALLOWLIST_RESOLUTION_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
      groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
      refreshedAt: parsed.refreshedAt || '',
    };
  } catch {}
  return { users: {}, groups: {}, refreshedAt: '' };
}

export function saveAllowlistResolution(resolution, filePath = ALLOWLIST_RESOLUTION_FILE) {
  writeJsonAtomic(filePath, {
    users: resolution.users || {},
    groups: resolution.groups || {},
    refreshedAt: resolution.refreshedAt || new Date().toISOString(),
  }, 0o600);
}

export function attachAllowlistResolution(config, resolution = loadAllowlistResolution()) {
  Object.defineProperty(config, '_allowlistResolution', {
    value: resolution,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return config;
}

export function allowlistResolutionIntervalMs(config) {
  const raw = Number(config.allowlistResolutionIntervalMs);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

export async function refreshAllowlistResolution(config, {
  findUsers,
  getMembers,
  logger = console,
  filePath = ALLOWLIST_RESOLUTION_FILE,
} = {}) {
  if (!findUsers || !getMembers) {
    const graph = await import('./graph.js');
    findUsers = findUsers || graph.findUsersByDisplayName;
    getMembers = getMembers || graph.getGroupMembersByName;
  }

  const entries = collectAllowEntries(config);
  const users = {};
  const groups = {};

  for (const entry of entries) {
    if (entry === '*' || entry.includes('*') || entry.includes('?')) continue;
    if (entry.toLowerCase().startsWith('group:')) {
      const groupName = normalize(entry.slice('group:'.length));
      if (!groupName) continue;
      try {
        groups[key(groupName)] = {
          displayName: groupName,
          members: await getMembers(groupName),
        };
      } catch (err) {
        logger.warn?.(`[ms-teams/allowlist] group:${groupName} resolution failed: ${err.message}`);
      }
      continue;
    }
    if (looksLikeDirectId(entry)) continue;
    try {
      const matches = await findUsers(entry);
      users[key(entry)] = matches.map(user => user.id).filter(Boolean);
    } catch (err) {
      logger.warn?.(`[ms-teams/allowlist] user "${entry}" resolution failed: ${err.message}`);
    }
  }

  const resolution = { users, groups, refreshedAt: new Date().toISOString() };
  attachAllowlistResolution(config, resolution);
  saveAllowlistResolution(resolution, filePath);
  return resolution;
}
