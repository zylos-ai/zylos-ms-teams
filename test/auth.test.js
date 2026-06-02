import { describe, expect, it } from 'vitest';
import { _isIssuerAcceptedForTest } from '../src/lib/auth.js';

describe('JWT issuer acceptance', () => {
  it('keeps broad legacy STS issuer support in multi-tenant mode', () => {
    expect(_isIssuerAcceptedForTest({
      issuer: 'https://sts.windows.net/tenant-a/',
    })).toBe(true);
    expect(_isIssuerAcceptedForTest({
      issuer: 'https://sts.windows.net/tenant-b/',
    })).toBe(true);
  });

  it('requires tenant-qualified legacy STS issuer in single-tenant mode', () => {
    expect(_isIssuerAcceptedForTest({
      tenantId: 'tenant-a',
      issuer: 'https://sts.windows.net/tenant-a/',
    })).toBe(true);
    expect(_isIssuerAcceptedForTest({
      tenantId: 'tenant-a',
      issuer: 'https://sts.windows.net/tenant-b/',
    })).toBe(false);
    expect(_isIssuerAcceptedForTest({
      tenantId: 'tenant-a',
      issuer: 'https://sts.windows.net/tenant-a/extra',
    })).toBe(false);
  });
});
