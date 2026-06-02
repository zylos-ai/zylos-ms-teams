import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { writeJsonAtomic } from './atomic-write.js';

export const SEEN_DM_USERS_FILE = path.join(DATA_DIR, 'seen-dm-users.json');

export function loadSeenDmUsers(filePath = SEEN_DM_USERS_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) return new Set(parsed.map(String));
    if (Array.isArray(parsed.users)) return new Set(parsed.users.map(String));
  } catch {}
  return new Set();
}

export function saveSeenDmUsers(users, filePath = SEEN_DM_USERS_FILE) {
  writeJsonAtomic(filePath, { users: Array.from(users).sort() }, 0o600);
}

export async function sendDmWelcomeIfFirstSeen({ ctx, aadObjectId, message, seenUsers, save = saveSeenDmUsers }) {
  const userId = String(aadObjectId || '').trim();
  const welcome = String(message || '').trim();
  if (!userId || !welcome || seenUsers.has(userId)) return false;
  seenUsers.add(userId);
  save(seenUsers);
  await ctx.send(welcome).catch(() => {});
  return true;
}
