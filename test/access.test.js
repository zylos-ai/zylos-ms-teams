import { describe, expect, it, vi } from 'vitest';
import { createAccessControl, createMentionHelpers } from '../src/lib/access.js';

vi.mock('../src/lib/config.js', () => ({
  saveConfig: vi.fn(() => true),
}));

describe('access control', () => {
  it('rejects all DMs when dmPolicy is disabled, including owner', () => {
    const access = createAccessControl(() => ({
      owner: {
        bound: true,
        aadObjectId: 'owner-aad',
        name: 'Owner',
      },
      dmPolicy: 'disabled',
      dmAllowFrom: ['allowed-aad'],
    }));

    expect(access.isDmAllowed('owner-aad', 'Owner')).toBe(false);
    expect(access.isDmAllowed('allowed-aad', 'Allowed User')).toBe(false);
  });
});

describe('mention helpers', () => {
  it('strips every occurrence of a repeated bot mention text', () => {
    const helpers = createMentionHelpers(() => 'bot-id');
    const activity = {
      text: '@Zylos @Zylos hello',
      entities: [{
        type: 'mention',
        text: '@Zylos',
        mentioned: { id: 'bot-id', name: 'Zylos' },
      }],
    };

    expect(helpers.stripBotMention(activity)).toBe('hello');
  });

  it('replaces every occurrence of a repeated bot mention text', () => {
    const helpers = createMentionHelpers(() => 'bot-id');
    const activity = {
      text: '@Zylos @Zylos hello',
      entities: [{
        type: 'mention',
        text: '@Zylos',
        mentioned: { id: 'bot-id', name: 'Zylos' },
      }],
    };

    expect(helpers.replaceBotMention(activity, 'Fallback')).toBe('Zylos Zylos hello');
  });
});
