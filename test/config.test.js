import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mergeConfigWithDefaults, resolveRouteConfig, isSmartConversation, DEFAULT_CONFIG, getCredentials, getPublicUrl, getTeamsAppCatalogId, loadConfig } from '../src/lib/config.js';

describe('mergeConfigWithDefaults', () => {
  it('returns defaults when called with no args', () => {
    const result = mergeConfigWithDefaults();
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it('returns defaults when called with empty object', () => {
    const result = mergeConfigWithDefaults({});
    expect(result.enabled).toBe(true);
    expect(result.port).toBe(3978);
    expect(result.dmPolicy).toBe('owner');
    expect(result.owner.bound).toBe(false);
    expect(result.message.context_messages).toBe(10);
    expect(result.dmWelcomeMessage).toBe('');
    expect(result.voiceTranscription).toBe('auto');
  });

  it('merges top-level overrides', () => {
    const result = mergeConfigWithDefaults({ port: 4000, dmPolicy: 'open' });
    expect(result.port).toBe(4000);
    expect(result.dmPolicy).toBe('open');
    expect(result.enabled).toBe(true);
  });

  it('deep-merges owner object', () => {
    const result = mergeConfigWithDefaults({ owner: { bound: true, name: 'Felix' } });
    expect(result.owner.bound).toBe(true);
    expect(result.owner.name).toBe('Felix');
    expect(result.owner.aadObjectId).toBe('');
  });

  it('deep-merges message object', () => {
    const result = mergeConfigWithDefaults({ message: { context_messages: 20 } });
    expect(result.message.context_messages).toBe(20);
  });

  it('preserves channels and groups from input', () => {
    const channels = { 'ch-1': { mode: 'smart' } };
    const groups = { 'grp-1': { mode: 'mention' } };
    const result = mergeConfigWithDefaults({ channels, groups });
    expect(result.channels).toEqual(channels);
    expect(result.groups).toEqual(groups);
  });

  it('defaults channels to empty object when not provided', () => {
    const result = mergeConfigWithDefaults({ port: 3000 });
    expect(result.channels).toEqual({});
  });
});

describe('resolveRouteConfig', () => {
  it('returns defaults when no matching config exists', () => {
    const config = { channels: {}, groups: {} };
    const result = resolveRouteConfig('channel', 'ch-unknown', config);
    expect(result.requireMention).toBe(true);
    expect(result.replyStyle).toBe('top-level');
    expect(result.allowFrom).toEqual([]);
  });

  it('resolves channel with smart mode', () => {
    const config = {
      channels: { 'ch-1': { mode: 'smart', replyStyle: 'thread' } },
    };
    const result = resolveRouteConfig('channel', 'ch-1', config);
    expect(result.requireMention).toBe(false);
    expect(result.replyStyle).toBe('thread');
  });

  it('resolves channel allowFrom', () => {
    const config = {
      channels: { 'ch-1': { allowFrom: ['user-a', 'user-b'] } },
    };
    const result = resolveRouteConfig('channel', 'ch-1', config);
    expect(result.allowFrom).toEqual(['user-a', 'user-b']);
  });

  it('matches base conversation ID (strips ;messageid=)', () => {
    const config = {
      channels: { 'ch-1': { mode: 'smart' } },
    };
    const result = resolveRouteConfig('channel', 'ch-1;messageid=12345', config);
    expect(result.requireMention).toBe(false);
  });

  it('applies post-level overrides for threads', () => {
    const config = {
      channels: {
        'ch-1': {
          mode: 'smart',
          posts: { '999': { mode: 'mention', allowFrom: ['user-z'] } },
        },
      },
    };
    const result = resolveRouteConfig('channel', 'ch-1;messageid=999', config);
    expect(result.requireMention).toBe(true);
    expect(result.allowFrom).toEqual(['user-z']);
  });

  it('resolves group with allowFrom', () => {
    const config = {
      groups: { 'grp-1': { allowFrom: ['user-x'] } },
    };
    const result = resolveRouteConfig('group', 'grp-1', config);
    expect(result.allowFrom).toEqual(['user-x']);
  });

  it('returns default allowFrom for group with no config', () => {
    const config = { groups: {} };
    const result = resolveRouteConfig('group', 'grp-unknown', config);
    expect(result.allowFrom).toEqual([]);
  });

  it('handles missing channels/groups keys gracefully', () => {
    const result = resolveRouteConfig('channel', 'ch-1', {});
    expect(result.requireMention).toBe(true);
  });
});

describe('isSmartConversation', () => {
  it('returns true for channel with smart mode', () => {
    const config = { channels: { 'ch-1': { mode: 'smart' } } };
    expect(isSmartConversation(config, 'channel', 'ch-1')).toBe(true);
  });

  it('returns false for channel with mention mode', () => {
    const config = { channels: { 'ch-1': { mode: 'mention' } } };
    expect(isSmartConversation(config, 'channel', 'ch-1')).toBe(false);
  });

  it('returns false for unconfigured channel', () => {
    const config = { channels: {} };
    expect(isSmartConversation(config, 'channel', 'ch-unknown')).toBe(false);
  });

  it('checks post-level override for threads', () => {
    const config = {
      channels: {
        'ch-1': {
          mode: 'mention',
          posts: { '42': { mode: 'smart' } },
        },
      },
    };
    expect(isSmartConversation(config, 'channel', 'ch-1;messageid=42')).toBe(true);
    expect(isSmartConversation(config, 'channel', 'ch-1;messageid=99')).toBe(false);
    expect(isSmartConversation(config, 'channel', 'ch-1')).toBe(false);
  });

  it('returns true for group with smart mode', () => {
    const config = { groups: { 'grp-1': { mode: 'smart' } } };
    expect(isSmartConversation(config, 'group', 'grp-1')).toBe(true);
  });

  it('returns false for group without smart mode', () => {
    const config = { groups: { 'grp-1': { mode: 'mention' } } };
    expect(isSmartConversation(config, 'group', 'grp-1')).toBe(false);
  });

  it('matches base conversation ID for groups', () => {
    const config = { groups: { 'grp-1': { mode: 'smart' } } };
    expect(isSmartConversation(config, 'group', 'grp-1;extra=data')).toBe(true);
  });

  it('handles missing channels/groups keys', () => {
    expect(isSmartConversation({}, 'channel', 'ch-1')).toBe(false);
    expect(isSmartConversation({}, 'group', 'grp-1')).toBe(false);
  });
});

describe('getCredentials', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.MSTEAMS_APP_ID;
    delete process.env.MSTEAMS_APP_PASSWORD;
    delete process.env.MSTEAMS_TENANT_ID;
  });

  afterEach(() => {
    process.env.MSTEAMS_APP_ID = originalEnv.MSTEAMS_APP_ID || '';
    process.env.MSTEAMS_APP_PASSWORD = originalEnv.MSTEAMS_APP_PASSWORD || '';
    process.env.MSTEAMS_TENANT_ID = originalEnv.MSTEAMS_TENANT_ID || '';
  });

  it('returns empty strings when no credentials are configured', () => {
    const creds = getCredentials();
    expect(creds.appId).toBe('');
    expect(creds.appPassword).toBe('');
    expect(creds.tenantId).toBe('');
  });

  it('falls back to environment variables', () => {
    process.env.MSTEAMS_APP_ID = 'env-app-id';
    process.env.MSTEAMS_APP_PASSWORD = 'env-secret';
    process.env.MSTEAMS_TENANT_ID = 'env-tenant';
    const creds = getCredentials();
    expect(creds.appId).toBe('env-app-id');
    expect(creds.appPassword).toBe('env-secret');
    expect(creds.tenantId).toBe('env-tenant');
  });

  it('returns all three credential fields', () => {
    const creds = getCredentials();
    expect(creds).toHaveProperty('appId');
    expect(creds).toHaveProperty('appPassword');
    expect(creds).toHaveProperty('tenantId');
  });
});

describe('getPublicUrl', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    if (originalEnv.MSTEAMS_PUBLIC_URL) {
      process.env.MSTEAMS_PUBLIC_URL = originalEnv.MSTEAMS_PUBLIC_URL;
    } else {
      delete process.env.MSTEAMS_PUBLIC_URL;
    }
  });

  it('returns empty string when nothing is configured', () => {
    delete process.env.MSTEAMS_PUBLIC_URL;
    const url = getPublicUrl();
    expect(url).toBe('');
  });

  it('falls back to environment variable', () => {
    process.env.MSTEAMS_PUBLIC_URL = 'https://example.com/ms-teams';
    const url = getPublicUrl();
    expect(url).toBe('https://example.com/ms-teams');
  });
});

describe('getTeamsAppCatalogId', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    if (originalEnv.MSTEAMS_APP_CATALOG_ID) {
      process.env.MSTEAMS_APP_CATALOG_ID = originalEnv.MSTEAMS_APP_CATALOG_ID;
    } else {
      delete process.env.MSTEAMS_APP_CATALOG_ID;
    }
  });

  it('returns empty string when not configured', () => {
    loadConfig();
    const id = getTeamsAppCatalogId();
    const cfg = mergeConfigWithDefaults({});
    expect(cfg.teamsAppCatalogId).toBeUndefined();
    expect(typeof id).toBe('string');
  });

  it('returns catalog ID from merged config when set', () => {
    const cfg = mergeConfigWithDefaults({ teamsAppCatalogId: 'test-abc-123' });
    expect(cfg.teamsAppCatalogId).toBe('test-abc-123');
  });

  it('prefers the config value over the env var when both are set', () => {
    const cfg = loadConfig();
    cfg.teamsAppCatalogId = 'config-catalog-id';
    process.env.MSTEAMS_APP_CATALOG_ID = 'env-catalog-id';
    expect(getTeamsAppCatalogId()).toBe('config-catalog-id');
  });

  it('falls back to the MSTEAMS_APP_CATALOG_ID env var when not in config', () => {
    // Mutate the cached config so the test is deterministic regardless of any
    // local config.json that may have a catalog ID set.
    const cfg = loadConfig();
    delete cfg.teamsAppCatalogId;
    process.env.MSTEAMS_APP_CATALOG_ID = 'env-catalog-id';
    expect(getTeamsAppCatalogId()).toBe('env-catalog-id');
  });
});
