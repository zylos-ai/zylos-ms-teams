import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let mockCatalogId = '';

vi.mock('../src/lib/config.js', () => ({
  getCredentials: () => ({
    appId: 'test-app-id',
    appPassword: 'test-secret',
    tenantId: 'test-tenant',
  }),
  getTeamsAppCatalogId: () => mockCatalogId,
  DATA_DIR: '/tmp/test-ms-teams',
}));

vi.mock('../src/lib/atomic-write.js', () => ({
  writeJsonAtomic: vi.fn(),
}));

const { buildAuthUrl, consumeState, _resolveGraphChatId, _chatIdCache, _setTokensForTest } = await import('../src/lib/delegated-auth.js');

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
  beforeEach(() => {
    mockCatalogId = '';
    _chatIdCache.clear();
    _setTokensForTest({});
    vi.restoreAllMocks();
  });

  afterEach(() => {
    mockCatalogId = '';
    _setTokensForTest({});
  });

  it('returns null when teamsAppCatalogId is not configured', async () => {
    mockCatalogId = '';
    const result = await _resolveGraphChatId('user-aad-id', 'a:conv123');
    expect(result).toBeNull();
  });

  it('returns null when no delegated token exists', async () => {
    mockCatalogId = 'catalog-id-123';
    const result = await _resolveGraphChatId('no-token-user', 'a:conv123');
    expect(result).toBeNull();
  });

  it('returns cached result without calling Graph', async () => {
    mockCatalogId = 'catalog-id-123';
    injectToken();
    const chatId = '19:cached-chat@unq.gbl.spaces';
    _chatIdCache.set('a:conv-cached', chatId);

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await _resolveGraphChatId('test-user', 'a:conv-cached');
    expect(result).toBe(chatId);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns chat ID when exactly one oneOnOne match and caches it', async () => {
    mockCatalogId = 'catalog-id-123';
    injectToken();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        value: [{ id: '19:correct-chat@unq.gbl.spaces', chatType: 'oneOnOne' }],
      }),
    }));

    const result = await _resolveGraphChatId('test-user', 'a:conv-single');
    expect(result).toBe('19:correct-chat@unq.gbl.spaces');
    expect(_chatIdCache.get('a:conv-single')).toBe('19:correct-chat@unq.gbl.spaces');
  });

  it('returns null when zero oneOnOne chats match', async () => {
    mockCatalogId = 'catalog-id-123';
    injectToken();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        value: [{ id: '19:group-chat@thread.v2', chatType: 'group' }],
      }),
    }));

    const result = await _resolveGraphChatId('test-user', 'a:conv-zero');
    expect(result).toBeNull();
  });

  it('returns null when multiple oneOnOne chats match (ambiguous)', async () => {
    mockCatalogId = 'catalog-id-123';
    injectToken();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        value: [
          { id: '19:chat-a@unq.gbl.spaces', chatType: 'oneOnOne' },
          { id: '19:chat-b@unq.gbl.spaces', chatType: 'oneOnOne' },
        ],
      }),
    }));

    const result = await _resolveGraphChatId('test-user', 'a:conv-ambig');
    expect(result).toBeNull();
  });

  it('sends correct Graph URL with encoded catalog filter and $select', async () => {
    mockCatalogId = 'my-catalog-id';
    injectToken();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ value: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await _resolveGraphChatId('test-user', 'a:conv-filter');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('https://graph.microsoft.com/v1.0/me/chats');
    expect(url).toContain(encodeURIComponent("installedApps/any(a:a/teamsApp/id eq 'my-catalog-id')"));
    expect(url).toContain('$select=id,chatType');
    expect(opts.headers.Authorization).toBe('Bearer test-graph-token');
  });

  it('evicts oldest cache entry at capacity via resolveGraphChatId', async () => {
    mockCatalogId = 'catalog-id-test';
    injectToken();

    for (let i = 0; i < 200; i++) {
      _chatIdCache.set(`conv-${i}`, `chat-${i}`);
    }
    expect(_chatIdCache.size).toBe(200);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        value: [{ id: '19:new-chat@unq.gbl.spaces', chatType: 'oneOnOne' }],
      }),
    }));

    const result = await _resolveGraphChatId('test-user', 'a:conv-new-evict');
    expect(result).toBe('19:new-chat@unq.gbl.spaces');
    expect(_chatIdCache.size).toBe(200);
    expect(_chatIdCache.has('conv-0')).toBe(false);
    expect(_chatIdCache.has('a:conv-new-evict')).toBe(true);
  });

  it('returns null when Graph API returns an error', async () => {
    mockCatalogId = 'catalog-id-123';
    injectToken();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    }));

    const result = await _resolveGraphChatId('test-user', 'a:conv-error');
    expect(result).toBeNull();
  });
});
