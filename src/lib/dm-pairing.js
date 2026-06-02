import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { writeJsonAtomic } from './atomic-write.js';

export const PAIRING_STATE_FILE = path.join(DATA_DIR, 'dm-pairing.json');

function normalizeUserId(userId) {
  return String(userId || '').trim();
}

export function loadPairingState(filePath = PAIRING_STATE_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
      denied: parsed.denied && typeof parsed.denied === 'object' ? parsed.denied : {},
    };
  } catch {}
  return { pending: {}, denied: {} };
}

export function savePairingState(state, filePath = PAIRING_STATE_FILE) {
  writeJsonAtomic(filePath, {
    pending: state.pending || {},
    denied: state.denied || {},
  }, 0o600);
}

export function getPairingStatus(userId, state = loadPairingState()) {
  const id = normalizeUserId(userId);
  if (!id) return 'unknown';
  if (state.denied?.[id]) return 'denied';
  if (state.pending?.[id]) return 'pending';
  return 'unknown';
}

export function markPairingPending({ userId, userName, conversationId, firstMessage }, state = loadPairingState()) {
  const id = normalizeUserId(userId);
  if (!id) return state;
  if (!state.pending) state.pending = {};
  if (!state.denied) state.denied = {};
  if (!state.pending[id] && !state.denied[id]) {
    state.pending[id] = {
      userId: id,
      userName: userName || 'unknown',
      conversationId: conversationId || '',
      firstMessage: String(firstMessage || '').substring(0, 500),
      requestedAt: new Date().toISOString(),
    };
  }
  return state;
}

export function approvePairingUser(config, userId, state = loadPairingState()) {
  const id = normalizeUserId(userId);
  if (!id) return false;
  if (!Array.isArray(config.dmAllowFrom)) config.dmAllowFrom = [];
  if (!config.dmAllowFrom.includes(id)) config.dmAllowFrom.push(id);
  delete state.pending?.[id];
  delete state.denied?.[id];
  return true;
}

export function denyPairingUser(config, userId, reason = '', state = loadPairingState()) {
  const id = normalizeUserId(userId);
  if (!id) return false;
  if (!state.denied) state.denied = {};
  state.denied[id] = {
    userId: id,
    deniedAt: new Date().toISOString(),
    reason: String(reason || '').trim(),
  };
  delete state.pending?.[id];
  if (Array.isArray(config.dmAllowFrom)) {
    config.dmAllowFrom = config.dmAllowFrom.filter(entry => String(entry) !== id);
  }
  return true;
}

export function buildPairingNotification({ userId, userName, conversationId, firstMessage }) {
  return [
    '[Teams DM Pairing Request]',
    `${userName || 'unknown'} (${userId}) requested DM access.`,
    `Conversation: ${conversationId || 'unknown'}`,
    firstMessage ? `First message: ${String(firstMessage).substring(0, 500)}` : '',
    '',
    `Approve: zylos-ms-teams dm-approve ${userId}`,
    `Deny: zylos-ms-teams dm-deny ${userId}`,
  ].filter(line => line !== '').join('\n');
}
