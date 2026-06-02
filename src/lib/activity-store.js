import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { writeJsonAtomic } from './atomic-write.js';

export const ACTIVITY_STATE_FILE = path.join(DATA_DIR, 'conversation-activity.json');
const DEFAULT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function loadActivityState(filePath = ACTIVITY_STATE_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      conversations: parsed.conversations && typeof parsed.conversations === 'object'
        ? parsed.conversations
        : {},
    };
  } catch {}
  return { conversations: {} };
}

export function saveActivityState(state, filePath = ACTIVITY_STATE_FILE) {
  writeJsonAtomic(filePath, { conversations: state.conversations || {} }, 0o600);
}

export function recordConversationActivity({ conversationId, type, name, at = new Date().toISOString() }, filePath = ACTIVITY_STATE_FILE) {
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
  saveActivityState(state, filePath);
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
