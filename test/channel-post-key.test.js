import { describe, it, expect } from 'vitest';
import { channelPostConversationId, referenceWithConversationType } from '../src/lib/format.js';
import { sessionGroupFromEndpoint } from '../src/lib/session-group.js';
import { historyKey } from '../src/lib/context.js';

const CH = '19:c@thread.tacv2';

describe('smart channel posts: one post = one group (review item 3)', () => {
  it('top-level post is keyed by its own message id, replies by the root', () => {
    expect(channelPostConversationId(CH, '100')).toBe(`${CH};messageid=100`);
    expect(channelPostConversationId(CH, '101', '100')).toBe(`${CH};messageid=100`);
  });

  it('a post and its replies share one session group and history; other posts do not', () => {
    const group = (id) => sessionGroupFromEndpoint(`${id}|type:channel`);
    const top = channelPostConversationId(CH, '100');
    const reply = channelPostConversationId(CH, '101', '100');
    const other = channelPostConversationId(CH, '200');
    expect(group(top)).toBe(group(reply));
    expect(historyKey(top)).toBe(historyKey(reply));
    expect(group(top)).not.toBe(group(other));
    expect(group(top)).not.toBe(group(CH));
    // Same group as a Bot Framework @mention on that post (conversation.id).
    expect(group(top)).toBe(group(`${CH};messageid=100`));
  });
});

describe('referenceWithConversationType', () => {
  it('adds the activity conversationType when the SDK ref lacks it', () => {
    const r = referenceWithConversationType({ conversation: { id: 'x' }, user: { id: 'u' } }, { conversation: { id: 'x', conversationType: 'groupChat' } });
    expect(r.conversation).toEqual({ id: 'x', conversationType: 'groupChat' });
    expect(r.user).toEqual({ id: 'u' });
  });
  it('keeps the ref when the type already matches or is unknown', () => {
    const ref = { conversation: { id: 'x', conversationType: 'personal' } };
    expect(referenceWithConversationType(ref, { conversation: { conversationType: 'personal' } })).toBe(ref);
    expect(referenceWithConversationType(ref, { conversation: {} })).toBe(ref);
  });
});
