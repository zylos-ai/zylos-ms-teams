import { describe, expect, it } from 'vitest';
import { buildGraphUrl, buildLoginUrl, getCloudConfig, normalizeCloudName } from '../src/lib/cloud.js';

describe('Microsoft cloud config', () => {
  it('normalizes cloud aliases', () => {
    expect(normalizeCloudName('public')).toBe('public');
    expect(normalizeCloudName('gcc-high')).toBe('gccHigh');
    expect(normalizeCloudName('USGov')).toBe('gccHigh');
    expect(normalizeCloudName('21vianet')).toBe('china');
  });

  it('falls back to public cloud for unknown names', () => {
    expect(getCloudConfig('unknown').name).toBe('public');
  });

  it('carries cloud-specific legacy STS issuers', () => {
    expect(getCloudConfig('public').legacyStsIssuer).toBe('https://sts.windows.net/');
    expect(getCloudConfig('gccHigh').legacyStsIssuer).toBe('https://sts.windows.net/');
    expect(getCloudConfig('china').legacyStsIssuer).toBe('https://sts.chinacloudapi.cn/');
  });

  it('builds cloud-specific login URLs', () => {
    expect(buildLoginUrl('tenant-1', 'public')).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    expect(buildLoginUrl('tenant-1', 'gccHigh')).toBe('https://login.microsoftonline.us/tenant-1/oauth2/v2.0/token');
    expect(buildLoginUrl('tenant-1', 'china', 'oauth2/v2.0/authorize')).toBe('https://login.chinacloudapi.cn/tenant-1/oauth2/v2.0/authorize');
  });

  it('builds cloud-specific Graph URLs', () => {
    expect(buildGraphUrl('/me', 'public')).toBe('https://graph.microsoft.com/v1.0/me');
    expect(buildGraphUrl('/me', 'dod')).toBe('https://dod-graph.microsoft.us/v1.0/me');
    expect(buildGraphUrl('https://example.com/path', 'china')).toBe('https://example.com/path');
  });
});
