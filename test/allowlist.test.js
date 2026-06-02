import { describe, expect, it } from 'vitest';
import { allowlistMatches, isConfiguredConversation, routeAllowlistMatches, selectConfiguredEntry } from '../src/lib/allowlist.js';

describe('allowlist helpers', () => {
  it('matches wildcard conversation arrays', () => {
    expect(isConfiguredConversation(['*'], '19:any@thread.v2')).toBe(true);
    expect(selectConfiguredEntry(['channel-*'], 'channel-general')).toEqual({});
    expect(isConfiguredConversation(['channel-*'], 'other')).toBe(false);
  });

  it('matches wildcard object keys', () => {
    const config = {
      '19:*@thread.v2': { name: 'Any thread' },
    };

    expect(selectConfiguredEntry(config, '19:abc@thread.v2')).toEqual({ name: 'Any thread' });
    expect(isConfiguredConversation(config, '19:abc@thread.v2;messageid=123')).toBe(true);
  });

  it('matches allowFrom entries by wildcard, display name, and resolved users', () => {
    const resolution = {
      users: {
        'felix lin': ['aad-felix'],
      },
      groups: {},
    };

    expect(allowlistMatches(['*'], { aadObjectId: 'anyone' })).toBe(true);
    expect(allowlistMatches(['aad-*'], { aadObjectId: 'aad-123' })).toBe(true);
    expect(allowlistMatches(['Felix Lin'], { aadObjectId: 'aad-felix' }, resolution)).toBe(true);
    expect(allowlistMatches(['Felix Lin'], { displayName: 'Felix Lin' })).toBe(true);
  });

  it('matches resolved Graph group members', () => {
    const resolution = {
      users: {},
      groups: {
        engineering: { members: ['aad-eng-1'] },
      },
    };

    expect(allowlistMatches(['group:Engineering'], { aadObjectId: 'aad-eng-1' }, resolution)).toBe(true);
    expect(allowlistMatches(['group:Engineering'], { aadObjectId: 'aad-other' }, resolution)).toBe(false);
  });

  it('treats empty route allowFrom as unrestricted', () => {
    expect(routeAllowlistMatches({}, { aadObjectId: 'aad-any' })).toBe(true);
    expect(routeAllowlistMatches({ allowFrom: ['aad-one'] }, { aadObjectId: 'aad-two' })).toBe(false);
  });
});
