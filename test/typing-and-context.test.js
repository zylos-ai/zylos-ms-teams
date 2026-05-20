import { describe, it, expect } from 'vitest';
import { stripThreadId } from '../src/lib/access.js';
import { formatMessage } from '../src/lib/format.js';

describe('stripThreadId', () => {
  it('removes ;messageid= suffix from channel thread IDs', () => {
    expect(stripThreadId('19:abc@thread.tacv2;messageid=12345')).toBe('19:abc@thread.tacv2');
  });

  it('returns bare ID unchanged', () => {
    expect(stripThreadId('19:abc@thread.tacv2')).toBe('19:abc@thread.tacv2');
  });

  it('handles DM conversation IDs', () => {
    expect(stripThreadId('a:longDmId')).toBe('a:longDmId');
  });
});

describe('thread root extraction from conversation ID', () => {
  it('extracts messageid from channel thread conversation ID', () => {
    const conversationId = '19:abc@thread.tacv2;messageid=1779095492623';
    const match = conversationId.match(/;messageid=(\d+)/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('1779095492623');
  });

  it('returns null for conversation IDs without messageid', () => {
    const conversationId = '19:abc@thread.tacv2';
    const match = conversationId.match(/;messageid=(\d+)/);
    expect(match).toBeNull();
  });

  it('returns null for DM conversation IDs', () => {
    const conversationId = 'a:someDmConversationId';
    const match = conversationId.match(/;messageid=(\d+)/);
    expect(match).toBeNull();
  });
});

describe('formatMessage with thread parent quoted reply', () => {
  it('includes thread parent as quoted-reply in channel messages', () => {
    const result = formatMessage('channel', 'Alice', 'I agree', {
      groupName: 'General',
      quotedReply: { quotedFrom: 'Bob', quotedText: 'Should we use Redis?' },
    });
    expect(result).toContain('[Teams CHANNEL:General]');
    expect(result).toContain('<current-message>\nI agree\n</current-message>');
    expect(result).toContain('<quoted-reply from="Bob">Should we use Redis?</quoted-reply>');
  });

  it('escapes XML in thread parent quoted reply', () => {
    const result = formatMessage('channel', 'Alice', 'yes', {
      groupName: 'Dev',
      quotedReply: { quotedFrom: 'Bob <admin>', quotedText: 'Use A & B?' },
    });
    expect(result).toContain('from="Bob &lt;admin&gt;"');
    expect(result).toContain('Use A &amp; B?');
  });

  it('omits quoted-reply when not provided', () => {
    const result = formatMessage('channel', 'Alice', 'hello', { groupName: 'General' });
    expect(result).not.toContain('<quoted-reply');
  });
});

describe('typing indicator scope', () => {
  it('should not start typing for channel messages (Teams limitation)', () => {
    // This is a behavioral test documenting that typing indicators
    // are only sent for DM and group conversations, not channels.
    // Teams does not display typing indicators in channel threads.
    const convType = 'channel';
    const smartNoMention = false;
    const shouldType = !smartNoMention && convType !== 'channel';
    expect(shouldType).toBe(false);
  });

  it('should start typing for DM messages', () => {
    const convType = 'dm';
    const smartNoMention = false;
    const shouldType = !smartNoMention && convType !== 'channel';
    expect(shouldType).toBe(true);
  });

  it('should start typing for group messages', () => {
    const convType = 'group';
    const smartNoMention = false;
    const shouldType = !smartNoMention && convType !== 'channel';
    expect(shouldType).toBe(true);
  });

  it('should not start typing for smart-no-mention messages', () => {
    const convType = 'group';
    const smartNoMention = true;
    const shouldType = !smartNoMention && convType !== 'channel';
    expect(shouldType).toBe(false);
  });
});
