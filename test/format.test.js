import { describe, it, expect } from 'vitest';
import { escapeXml, buildEndpoint, parseC4Response, getConversationType, formatMessage, extractChannelIds } from '../src/lib/format.js';

describe('escapeXml', () => {
  it('escapes all XML special characters', () => {
    expect(escapeXml('&<>\'"')).toBe('&amp;&lt;&gt;&apos;&quot;');
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(undefined)).toBe('');
  });

  it('converts numbers to string', () => {
    expect(escapeXml(42)).toBe('42');
  });

  it('passes through safe text unchanged', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });
});

describe('buildEndpoint', () => {
  it('returns conversationId alone with no options', () => {
    expect(buildEndpoint('conv-123')).toBe('conv-123');
  });

  it('appends type, user, and msg fields', () => {
    expect(buildEndpoint('conv-123', {
      type: 'dm',
      aadObjectId: 'user-abc',
      activityId: 'act-1',
    })).toBe('conv-123|type:dm|user:user-abc|msg:act-1');
  });

  it('omits missing optional fields', () => {
    expect(buildEndpoint('conv-123', { type: 'group' })).toBe('conv-123|type:group');
  });
});

describe('parseC4Response', () => {
  it('parses valid JSON', () => {
    expect(parseC4Response('{"ok":true}')).toEqual({ ok: true });
  });

  it('trims whitespace before parsing', () => {
    expect(parseC4Response('  {"a":1}  \n')).toEqual({ a: 1 });
  });

  it('returns null for invalid JSON', () => {
    expect(parseC4Response('not json')).toBe(null);
  });

  it('returns null for empty/null input', () => {
    expect(parseC4Response('')).toBe(null);
    expect(parseC4Response(null)).toBe(null);
    expect(parseC4Response(undefined)).toBe(null);
  });
});

describe('getConversationType', () => {
  it('returns dm for personal', () => {
    expect(getConversationType({ conversation: { conversationType: 'personal' } })).toBe('dm');
  });

  it('returns group for groupChat', () => {
    expect(getConversationType({ conversation: { conversationType: 'groupChat' } })).toBe('group');
  });

  it('returns channel for channel', () => {
    expect(getConversationType({ conversation: { conversationType: 'channel' } })).toBe('channel');
  });

  it('defaults to dm for unknown type', () => {
    expect(getConversationType({ conversation: {} })).toBe('dm');
    expect(getConversationType({})).toBe('dm');
  });
});

describe('formatMessage', () => {
  it('formats a DM message', () => {
    const result = formatMessage('dm', 'Alice', 'hello');
    expect(result).toContain('[Teams DM]');
    expect(result).toContain('Alice said:');
    expect(result).toContain('<current-message>\nhello\n</current-message>');
  });

  it('formats a group message with group name', () => {
    const result = formatMessage('group', 'Bob', 'hi', { groupName: 'Dev Team' });
    expect(result).toContain('[Teams GROUP:Dev Team]');
  });

  it('formats a channel message', () => {
    const result = formatMessage('channel', 'Carol', 'test', { groupName: 'General' });
    expect(result).toContain('[Teams CHANNEL:General]');
  });

  it('escapes XML in user name and text', () => {
    const result = formatMessage('dm', '<script>', 'a&b');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('a&amp;b');
  });

  it('includes quoted reply when provided', () => {
    const result = formatMessage('dm', 'Alice', 'yes', {
      quotedReply: { quotedFrom: 'Bob', quotedText: 'original' },
    });
    expect(result).toContain('<quoted-reply from="Bob">original</quoted-reply>');
  });

  it('includes smart hint when enabled', () => {
    const result = formatMessage('dm', 'Alice', 'hi', { smartHint: true });
    expect(result).toContain('<smart-mode>');
    expect(result).toContain('[SKIP]');
  });

  it('includes context block when provided', () => {
    const result = formatMessage('dm', 'Alice', 'hi', { contextBlock: '[context]' });
    expect(result).toContain('[context]');
  });

  it('uses "unknown" when groupName is missing for group/channel', () => {
    const group = formatMessage('group', 'X', 'y');
    expect(group).toContain('GROUP:unknown');
    const channel = formatMessage('channel', 'X', 'y');
    expect(channel).toContain('CHANNEL:unknown');
  });
});

describe('extractChannelIds', () => {
  it('extracts from team.aadGroupId and teamsChannelId', () => {
    const result = extractChannelIds({
      team: { aadGroupId: 'aad-123', id: 'id-456' },
      teamsChannelId: 'ch-789',
      channel: { id: 'ch-alt' },
    });
    expect(result).toEqual({ teamId: 'aad-123', channelId: 'ch-789' });
  });

  it('falls back to team.id and channel.id', () => {
    const result = extractChannelIds({
      team: { id: 'id-456' },
      channel: { id: 'ch-alt' },
    });
    expect(result).toEqual({ teamId: 'id-456', channelId: 'ch-alt' });
  });

  it('falls back to teamId and channelId', () => {
    const result = extractChannelIds({ teamId: 't-1', channelId: 'c-2' });
    expect(result).toEqual({ teamId: 't-1', channelId: 'c-2' });
  });

  it('returns empty strings when channelData is null/undefined', () => {
    expect(extractChannelIds(null)).toEqual({ teamId: '', channelId: '' });
    expect(extractChannelIds(undefined)).toEqual({ teamId: '', channelId: '' });
  });

  it('returns empty strings when fields are missing', () => {
    expect(extractChannelIds({})).toEqual({ teamId: '', channelId: '' });
  });
});
