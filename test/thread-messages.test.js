import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getThreadMessages } from '../src/lib/graph.js';

describe('Graph thread messages', () => {
  const originalEnv = { ...process.env };
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.MSTEAMS_APP_ID = 'app-id';
    process.env.MSTEAMS_APP_PASSWORD = 'secret';
    process.env.MSTEAMS_TENANT_ID = 'tenant-id';
  });

  afterEach(() => {
    process.env.MSTEAMS_APP_ID = originalEnv.MSTEAMS_APP_ID || '';
    process.env.MSTEAMS_APP_PASSWORD = originalEnv.MSTEAMS_APP_PASSWORD || '';
    process.env.MSTEAMS_TENANT_ID = originalEnv.MSTEAMS_TENANT_ID || '';
    globalThis.fetch = realFetch;
  });

  it('fetches channel thread replies using the supplied team and channel IDs', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      value: [{
        id: 'reply-1',
        createdDateTime: '2026-06-02T10:00:00Z',
        from: { user: { displayName: 'Felix' } },
        body: { contentType: 'text', content: 'thread reply' },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const messages = await getThreadMessages('channel-1;messageid=root-1', 'root-1', 5, {
      teamId: 'team-1',
      channelId: 'channel-1',
      delegatedToken: 'delegated-token',
    });

    expect(messages).toEqual([expect.objectContaining({
      id: 'reply-1',
      from: 'Felix',
      body: 'thread reply',
    })]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/messages/root-1/replies?$top=5',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer delegated-token' }),
      }),
    );
  });
});
