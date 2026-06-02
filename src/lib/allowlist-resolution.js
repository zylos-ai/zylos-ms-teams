import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/ms-teams');
export const ALLOWLIST_RESOLUTION_FILE = path.join(DATA_DIR, 'allowlist-resolution.json');
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_CONCURRENCY = 5;

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

async function allSettledWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const numericLimit = Number(limit);
  const normalizedLimit = Number.isFinite(numericLimit) && numericLimit > 0
    ? Math.floor(numericLimit)
    : DEFAULT_CONCURRENCY;
  const workerCount = Math.min(normalizedLimit, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      try {
        results[index] = { status: 'fulfilled', value: await worker(item), item };
      } catch (err) {
        results[index] = { status: 'rejected', reason: err, item };
      }
    }
  }));

  return results;
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
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  if (!findUsers || !getMembers) {
    const graph = await import('./graph.js');
    findUsers = findUsers || graph.findUsersByDisplayName;
    getMembers = getMembers || graph.getGroupMembersByName;
  }

  const entries = collectAllowEntries(config);
  const users = {};
  const groups = {};
  const tasks = [];

  for (const entry of entries) {
    if (entry === '*' || entry.includes('*') || entry.includes('?')) continue;
    if (entry.toLowerCase().startsWith('group:')) {
      const groupName = normalize(entry.slice('group:'.length));
      if (!groupName) continue;
      tasks.push({ type: 'group', displayName: groupName, key: key(groupName) });
      continue;
    }
    if (looksLikeDirectId(entry)) continue;
    tasks.push({ type: 'user', displayName: entry, key: key(entry) });
  }

  const settled = await allSettledWithLimit(tasks, concurrency, async task => {
    if (task.type === 'group') {
      return {
        ...task,
        members: await getMembers(task.displayName),
      };
    }
    const matches = await findUsers(task.displayName);
    return {
      ...task,
      users: matches.map(user => user.id).filter(Boolean),
    };
  });

  for (const result of settled) {
    const task = result.item;
    if (result.status === 'rejected') {
      const message = result.reason?.message || String(result.reason);
      if (task.type === 'group') {
        logger.warn?.(`[ms-teams/allowlist] group:${task.displayName} resolution failed: ${message}`);
      } else {
        logger.warn?.(`[ms-teams/allowlist] user "${task.displayName}" resolution failed: ${message}`);
      }
      continue;
    }
    const resolved = result.value;
    if (resolved.type === 'group') {
      groups[resolved.key] = {
        displayName: resolved.displayName,
        members: resolved.members,
      };
    } else {
      users[resolved.key] = resolved.users;
    }
  }

  const resolution = { users, groups, refreshedAt: new Date().toISOString() };
  attachAllowlistResolution(config, resolution);
  saveAllowlistResolution(resolution, filePath);
  return resolution;
}
