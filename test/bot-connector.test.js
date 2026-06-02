import { describe, expect, it, vi } from 'vitest';
import { readActivityIdFromResponse } from '../src/lib/bot-connector.js';

function response({ json, headers = {} } = {}) {
  return {
    headers: {
      get: (name) => headers[name.toLowerCase()] || '',
    },
    json,
  };
}

describe('Bot Connector helpers', () => {
  it('reads activity id from JSON responses', async () => {
    const id = await readActivityIdFromResponse(response({
      headers: { 'content-type': 'application/json' },
      json: async () => ({ id: 'activity-1' }),
    }));

    expect(id).toBe('activity-1');
  });

  it('falls back to location headers when JSON parsing fails', async () => {
    const log = vi.fn();
    const id = await readActivityIdFromResponse(response({
      headers: {
        'content-type': 'application/json',
        'resource-location': 'https://service/v3/conversations/c1/activities/activity-2',
      },
      json: async () => { throw new Error('not json'); },
    }), { log });

    expect(id).toBe('activity-2');
    expect(log).toHaveBeenCalledOnce();
  });

  it('returns empty string when no activity id is available', async () => {
    const id = await readActivityIdFromResponse(response({
      headers: { 'content-type': 'text/plain' },
    }));

    expect(id).toBe('');
  });
});
