import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We test the internal logic by creating a temporary store directory
// and importing the module functions. Since the module uses process.env.HOME,
// we need to test via the exported async functions with a real temp dir.

import { saveConversationReference, getConversationReference, getAllConversationReferences, removeConversationReference, reloadStore } from '../src/lib/conversation-store.js';

describe('conversation-store (async)', () => {
  // These tests use the real store path (~/zylos/components/ms-teams/conversations.json)
  // so we back up and restore the file around tests.
  const HOME = process.env.HOME;
  const STORE_PATH = path.join(HOME, 'zylos/components/ms-teams/conversations.json');
  const LOCK_PATH = STORE_PATH + '.lock';
  const BACKUP_PATH = STORE_PATH + '.test-backup';
  let hadExistingStore = false;

  beforeEach(() => {
    hadExistingStore = fs.existsSync(STORE_PATH);
    if (hadExistingStore) {
      fs.copyFileSync(STORE_PATH, BACKUP_PATH);
    }
    // Clean lock file if stale
    try { fs.unlinkSync(LOCK_PATH); } catch {}
  });

  afterEach(async () => {
    if (hadExistingStore) {
      fs.copyFileSync(BACKUP_PATH, STORE_PATH);
      fs.unlinkSync(BACKUP_PATH);
    } else {
      try { fs.unlinkSync(STORE_PATH); } catch {}
    }
    try { fs.unlinkSync(LOCK_PATH); } catch {}
    await reloadStore();
  });

  it('saves and retrieves a conversation reference', async () => {
    const ref = { bot: { id: 'bot-1' }, serviceUrl: 'https://example.com' };
    await saveConversationReference('conv-test-1', ref);
    const result = await getConversationReference('conv-test-1');
    expect(result).toBeTruthy();
    expect(result.bot.id).toBe('bot-1');
    expect(result.serviceUrl).toBe('https://example.com');
  });

  it('returns null for non-existent conversation', async () => {
    await reloadStore();
    const result = await getConversationReference('non-existent-conv');
    expect(result).toBe(null);
  });

  it('stores tenantId when provided', async () => {
    const ref = { bot: { id: 'bot-2' } };
    await saveConversationReference('conv-test-2', ref, { tenantId: 'tenant-abc' });
    const result = await getConversationReference('conv-test-2');
    expect(result.tenantId).toBe('tenant-abc');
  });

  it('removes a conversation reference', async () => {
    const ref = { bot: { id: 'bot-3' } };
    await saveConversationReference('conv-test-3', ref);
    await removeConversationReference('conv-test-3');
    const result = await getConversationReference('conv-test-3');
    expect(result).toBe(null);
  });

  it('getAllConversationReferences returns all entries', async () => {
    await saveConversationReference('conv-a', { bot: { id: 'a' } });
    await saveConversationReference('conv-b', { bot: { id: 'b' } });
    const all = await getAllConversationReferences();
    expect(all['conv-a']).toBeTruthy();
    expect(all['conv-b']).toBeTruthy();
  });

  it('does not block the event loop during lock retry', async () => {
    // Create a lock file to simulate contention
    fs.writeFileSync(LOCK_PATH, '99999');

    const start = Date.now();
    // Start a save that will need to wait for the lock
    // The lock file is fresh (< 10s old), so it will retry with setTimeout
    // We set a short timeout by deleting the lock after 200ms
    const unlockTimer = setTimeout(() => {
      try { fs.unlinkSync(LOCK_PATH); } catch {}
    }, 200);

    const ref = { bot: { id: 'delayed' } };
    await saveConversationReference('conv-delayed', ref);
    clearTimeout(unlockTimer);

    const elapsed = Date.now() - start;
    // Should have waited ~200ms (async sleep), not busy-waited
    // The key assertion: the save eventually succeeds
    const result = await getConversationReference('conv-delayed');
    expect(result).toBeTruthy();
    expect(result.bot.id).toBe('delayed');
  });
});
