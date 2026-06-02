import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/config.js', () => ({
  getCredentials: () => ({
    appId: 'test-app-id',
    appPassword: 'test-secret',
    tenantId: 'test-tenant',
  }),
  getConfig: () => ({ cloud: 'public' }),
  DATA_DIR: '/tmp/test-ms-teams',
}));

const { acquireTokenForScope, _clearTokenCacheForTest } = await import('../src/lib/graph.js');

describe('acquireTokenForScope coalescing', () => {
  beforeEach(() => {
    _clearTokenCacheForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('coalesces concurrent token requests for the same resolved scope', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'app-token',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      acquireTokenForScope('graph'),
      acquireTokenForScope('graph'),
    ]);

    expect(first).toBe('app-token');
    expect(second).toBe('app-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
