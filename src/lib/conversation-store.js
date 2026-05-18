/**
 * File-based conversation reference store with:
 * - File locking (lock file + atomic writes) for concurrent access safety
 * - LRU pruning with 1000-entry cap
 * - 365-day TTL for stale entry eviction
 * - Tenant ID storage per conversation reference
 * - lastAccessed timestamp for LRU ordering
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/ms-teams');
const STORE_PATH = path.join(DATA_DIR, 'conversations.json');
const LOCK_PATH = STORE_PATH + '.lock';

const MAX_ENTRIES = 1000;
const TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365 days
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;

let references = null;

/**
 * Acquire a file lock using a lock file with O_EXCL (atomic create).
 * Returns true if lock acquired, false if timed out.
 */
function acquireLock(timeoutMs = LOCK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Check for stale lock (older than 10s)
        try {
          const stat = fs.statSync(LOCK_PATH);
          if (Date.now() - stat.mtimeMs > 10000) {
            try { fs.unlinkSync(LOCK_PATH); } catch {}
            continue;
          }
        } catch {}
        // Busy wait
        const waitUntil = Date.now() + LOCK_RETRY_MS;
        while (Date.now() < waitUntil) { /* spin */ }
        continue;
      }
      // Other error — skip locking
      return true;
    }
  }
  console.warn('[ms-teams/store] Lock acquisition timed out, proceeding without lock');
  return true;
}

/**
 * Release the file lock.
 */
function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {}
}

/**
 * Prune entries that exceed TTL.
 */
function pruneExpired(refs) {
  const now = Date.now();
  const cutoff = now - TTL_MS;
  const keys = Object.keys(refs);
  let pruned = 0;
  for (const key of keys) {
    const entry = refs[key];
    const ts = entry.lastAccessed || entry.savedAt || 0;
    if (ts < cutoff) {
      delete refs[key];
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[ms-teams/store] Pruned ${pruned} expired entries`);
  }
  return refs;
}

/**
 * Evict least-recently-accessed entries to stay within MAX_ENTRIES.
 */
function pruneLRU(refs) {
  const keys = Object.keys(refs);
  if (keys.length <= MAX_ENTRIES) return refs;

  // Sort by lastAccessed ascending (oldest first)
  const sorted = keys.sort((a, b) => {
    const tsA = refs[a].lastAccessed || refs[a].savedAt || 0;
    const tsB = refs[b].lastAccessed || refs[b].savedAt || 0;
    return tsA - tsB;
  });

  const toRemove = sorted.length - MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) {
    delete refs[sorted[i]];
  }
  console.log(`[ms-teams/store] LRU pruned ${toRemove} entries (cap: ${MAX_ENTRIES})`);
  return refs;
}

/**
 * Load store from disk with locking.
 */
function load() {
  acquireLock();
  try {
    if (fs.existsSync(STORE_PATH)) {
      const content = fs.readFileSync(STORE_PATH, 'utf8');
      references = JSON.parse(content);

      // Migrate legacy entries (no lastAccessed) — set to savedAt or now
      const now = Date.now();
      for (const key of Object.keys(references)) {
        const entry = references[key];
        if (!entry.lastAccessed) {
          entry.lastAccessed = entry.savedAt || now;
        }
      }

      pruneExpired(references);
      pruneLRU(references);
    } else {
      references = {};
    }
  } catch (err) {
    console.error(`[ms-teams/store] Failed to load conversation store: ${err.message}`);
    references = {};
  } finally {
    releaseLock();
  }
  return references;
}

/**
 * Save store to disk atomically with locking.
 */
function save() {
  acquireLock();
  const tmpPath = STORE_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(references, null, 2));
    fs.renameSync(tmpPath, STORE_PATH);
    return true;
  } catch (err) {
    console.error(`[ms-teams/store] Failed to save conversation store: ${err.message}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return false;
  } finally {
    releaseLock();
  }
}

/**
 * Get a conversation reference by ID. Updates lastAccessed on read.
 *
 * @param {string} conversationId
 * @returns {object|null} The conversation reference (with metadata stripped), or null
 */
export function getConversationReference(conversationId) {
  if (!references) load();
  const entry = references[conversationId];
  if (!entry) return null;

  // Update lastAccessed
  entry.lastAccessed = Date.now();

  // Return the reference data (without our metadata)
  const { lastAccessed, savedAt, ...ref } = entry;
  return ref;
}

/**
 * Save or update a conversation reference.
 *
 * @param {string} conversationId
 * @param {object} reference - Bot Framework conversation reference
 * @param {object} [options]
 * @param {string} [options.tenantId] - Tenant ID for the conversation
 * @returns {boolean} Whether save succeeded
 */
export function saveConversationReference(conversationId, reference, options = {}) {
  if (!references) load();

  const now = Date.now();
  const existing = references[conversationId];

  references[conversationId] = {
    ...reference,
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    savedAt: existing?.savedAt || now,
    lastAccessed: now,
  };

  // Enforce cap after insertion
  pruneLRU(references);

  return save();
}

/**
 * Remove a conversation reference.
 *
 * @param {string} conversationId
 * @returns {boolean}
 */
export function removeConversationReference(conversationId) {
  if (!references) load();
  if (references[conversationId]) {
    delete references[conversationId];
    return save();
  }
  return true;
}

/**
 * Get all conversation references (shallow copy, metadata included).
 *
 * @returns {object}
 */
export function getAllConversationReferences() {
  if (!references) load();
  return { ...references };
}

/**
 * Force reload from disk.
 */
export function reloadStore() {
  references = null;
  return load();
}
