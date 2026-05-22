import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordHistoryEntry, getInMemoryContext } from '../src/lib/history.js';

describe('recordHistoryEntry ACL integration', () => {
  const config = { message: { context_messages: 10 } };
  const chatId = 'test-chat-acl';

  it('accepted message appears in context', () => {
    const entry = {
      timestamp: new Date().toISOString(),
      message_id: 'accepted-1',
      user_id: 'user-a',
      user_name: 'Alice',
      text: 'hello from allowed user',
    };
    recordHistoryEntry(chatId, entry, config);
    const context = getInMemoryContext(chatId, null, 10);
    expect(context.some(m => m.message_id === 'accepted-1')).toBe(true);
  });

  it('messages not recorded do not appear in context', () => {
    const rejectedChatId = 'rejected-chat';
    const context = getInMemoryContext(rejectedChatId, null, 10);
    expect(context.length).toBe(0);
  });

  it('deduplicates by message_id', () => {
    const dedupChat = 'dedup-chat';
    const entry = {
      timestamp: new Date().toISOString(),
      message_id: 'dup-1',
      user_id: 'user-b',
      user_name: 'Bob',
      text: 'duplicate test',
    };
    recordHistoryEntry(dedupChat, entry, config);
    recordHistoryEntry(dedupChat, entry, config);
    const context = getInMemoryContext(dedupChat, null, 10);
    const matches = context.filter(m => m.message_id === 'dup-1');
    expect(matches.length).toBe(1);
  });
});
