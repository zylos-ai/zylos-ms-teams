import { describe, expect, it } from 'vitest';
import { historyKey, chatIdToLogFile } from '../src/lib/context.js';
import { recordHistoryEntry, getInMemoryContext } from '../src/lib/history.js';

describe('per-post history', () => {
  const ch = '19:abc@thread.tacv2';

  it('keeps the post id so each channel post has its own history', () => {
    expect(historyKey(`${ch};messageid=111`)).toBe(`${ch};messageid=111`);
    expect(historyKey(`${ch};messageid=111`)).not.toBe(historyKey(`${ch};messageid=222`));
    expect(historyKey(ch)).toBe(ch);
    expect(historyKey('a:dm-id;skypeparam=1')).toBe('a:dm-id');
  });

  it('log files are per post and filesystem-safe', () => {
    expect(chatIdToLogFile(`${ch};messageid=111`)).toBe('19_abc_thread.tacv2_messageid_111.jsonl');
    expect(chatIdToLogFile(`${ch};messageid=111`)).not.toBe(chatIdToLogFile(`${ch};messageid=222`));
  });

  it('context of one post does not include another post', () => {
    const t = new Date().toISOString();
    recordHistoryEntry(`${ch};messageid=901`, { timestamp: t, message_id: 'p1', user_id: 'u', user_name: 'U', text: 'post one' }, {});
    recordHistoryEntry(`${ch};messageid=902`, { timestamp: t, message_id: 'p2', user_id: 'u', user_name: 'U', text: 'post two' }, {});
    const ctx = getInMemoryContext(`${ch};messageid=902`, 'x', 10).map(m => m.text);
    expect(ctx).toEqual(['post two']);
  });
});
