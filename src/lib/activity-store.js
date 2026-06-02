import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { writeJsonAtomic } from './atomic-write.js';

export const ACTIVITY_STATE_FILE = path.join(DATA_DIR, 'conversation-activity.json');
const DEFAULT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const FLUSH_DELAY_MS = 250;
const stateCache = new Map();
const flushTimers = new Map();

export function loadActivityState(filePath = ACTIVITY_STATE_FILE) {
  if (stateCache.has(filePath)) return stateCache.get(filePath);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const state = {
      conversations: parsed.conversations && typeof parsed.conversations === 'object'
        ? parsed.conversations
        : {},
    };
    stateCache.set(filePath, state);
    return state;
  } catch {}
  const state = { conversations: {} };
  stateCache.set(filePath, state);
  return state;
}

export function saveActivityState(state, filePath = ACTIVITY_STATE_FILE) {
  stateCache.set(filePath, state);
  writeJsonAtomic(filePath, { conversations: state.conversations || {} }, 0o600);
}

function scheduleActivityFlush(filePath, { debounce = filePath === ACTIVITY_STATE_FILE } = {}) {
  if (!debounce) {
    flushActivityState(filePath);
    return;
  }
  const existing = flushTimers.get(filePath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    flushTimers.delete(filePath);
    flushActivityState(filePath);
  }, FLUSH_DELAY_MS);
  timer.unref?.();
  flushTimers.set(filePath, timer);
}

export function flushActivityState(filePath = ACTIVITY_STATE_FILE) {
  const timer = flushTimers.get(filePath);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(filePath);
  }
  const state = stateCache.get(filePath);
  if (state) {
    writeJsonAtomic(filePath, { conversations: state.conversations || {} }, 0o600);
  }
}

export function recordConversationActivity({ conversationId, type, name, at = new Date().toISOString() }, filePath = ACTIVITY_STATE_FILE, options = {}) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const baseId = id.split(';')[0];
  const state = loadActivityState(filePath);
  state.conversations[baseId] = {
    conversationId: baseId,
    type: type || 'unknown',
    name: name || baseId,
    lastActivityAt: at,
  };
  stateCache.set(filePath, state);
  scheduleActivityFlush(filePath, options);
}

export function recentActivityFor(conversationId, {
  filePath = ACTIVITY_STATE_FILE,
  now = Date.now(),
  windowMs = DEFAULT_ACTIVE_WINDOW_MS,
} = {}) {
  const id = String(conversationId || '').split(';')[0];
  const entry = loadActivityState(filePath).conversations[id];
  if (!entry?.lastActivityAt) return null;
  const last = new Date(entry.lastActivityAt).getTime();
  if (!Number.isFinite(last) || now - last > windowMs) return null;
  return entry;
}

export function warningForActiveConversation(conversationId, action, options = {}) {
  const entry = recentActivityFor(conversationId, options);
  if (!entry) return '';
  return `WARNING: ${action} affects active ${entry.type} "${entry.name || entry.conversationId}" (last message ${entry.lastActivityAt}).`;
}
