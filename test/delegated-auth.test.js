import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/config.js', () => ({
  getCredentials: () => ({
    appId: 'test-app-id',
    appPassword: 'test-secret',
    tenantId: 'test-tenant',
  }),
  getConfig: () => ({ cloud: 'public' }),
  DATA_DIR: '/tmp/test-ms-teams',
}));

vi.mock('../src/lib/atomic-write.js', () => ({
  writeJsonAtomic: vi.fn(),
}));

const { buildAuthUrl, consumeState, exchangeCode, getDelegatedToken, _resolveGraphChatId, _setTokensForTest } = await import('../src/lib/delegated-auth.js');

function injectToken(aadObjectId = 'test-user') {
  _setTokensForTest({
    [aadObjectId]: {
      accessToken: 'test-graph-token',
      expiresAt: Date.now() + 3600_000,
      displayName: 'Test User',
    },
  });
}

describe('consumeState', () => {
  it('returns stored state data and deletes it atomically', () => {
    const redirectUri = 'https://example.com/auth/callback';
    const { state } = buildAuthUrl(redirectUri);

    const consumed = consumeState(state);
    expect(consumed).not.toBeNull();
    expect(consumed.redirectUri).toBe(redirectUri);
    expect(consumed.timestamp).toBeGreaterThan(0);
  });

  it('returns null on second call with same state (replay blocked)', () => {
    const { state } = buildAuthUrl('https://example.com/auth/callback');

    const first = consumeState(state);
    expect(first).not.toBeNull();

    const second = consumeState(state);
    expect(second).toBeNull();
  });

  it('returns null for unknown state', () => {
    expect(consumeState('nonexistent-state-value')).toBeNull();
  });

  it('preserves the redirectUri bound at auth URL creation time', () => {
    const originalUri = 'https://bot.example.com/ms-teams/auth/callback';
    const { state } = buildAuthUrl(originalUri);

    const consumed = consumeState(state);
    expect(consumed.redirectUri).toBe(originalUri);
  });
});

describe('resolveGraphChatId', () => {
  it('constructs chat ID from user AAD ID and bot app ID', () => {
    const result = _resolveGraphChatId('user-aad-id');
    expect(result).toBe('19:user-aad-id_test-app-id@unq.gbl.spaces');
  });

  it('returns different chat IDs for different users', () => {
    const result1 = _resolveGraphChatId('user-a');
    const result2 = _resolveGraphChatId('user-b');
    expect(result1).not.toBe(result2);
    expect(result1).toBe('19:user-a_test-app-id@unq.gbl.spaces');
    expect(result2).toBe('19:user-b_test-app-id@unq.gbl.spaces');
  });
});

describe('getDelegatedToken refresh coalescing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('coalesces concurrent refreshes for the same user', async () => {
    _setTokensForTest({
      'test-user': {
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 1000,
        displayName: 'Test User',
      },
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'fresh-token',
        refresh_token: 'fresh-refresh-token',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      getDelegatedToken('test-user'),
      getDelegatedToken('test-user'),
    ]);

    expect(first).toBe('fresh-token');
    expect(second).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('exchangeCode token parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fails cleanly when access token payload cannot identify the user', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'not-a-jwt',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      }),
    })));

    await expect(exchangeCode('code', 'https://example.com/auth/callback'))
      .rejects.toThrow('missing user identifier');
  });
});
