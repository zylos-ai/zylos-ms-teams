import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildRedirectUri } from '../src/routes.js';

function mockReq(headers = {}) {
  return {
    protocol: 'http',
    headers: {
      host: 'localhost:3978',
      ...headers,
    },
  };
}

describe('buildRedirectUri', () => {
  afterEach(() => {
    delete process.env.MSTEAMS_PUBLIC_URL;
  });

  it('uses origin + pathname from MSTEAMS_PUBLIC_URL', () => {
    process.env.MSTEAMS_PUBLIC_URL = 'https://felix-lin.coco.site/ms-teams';
    const uri = buildRedirectUri(mockReq());
    expect(uri).toBe('https://felix-lin.coco.site/ms-teams/auth/callback');
  });

  it('strips trailing slash from MSTEAMS_PUBLIC_URL pathname', () => {
    process.env.MSTEAMS_PUBLIC_URL = 'https://felix-lin.coco.site/ms-teams/';
    const uri = buildRedirectUri(mockReq());
    expect(uri).toBe('https://felix-lin.coco.site/ms-teams/auth/callback');
  });

  it('works when MSTEAMS_PUBLIC_URL has no path', () => {
    process.env.MSTEAMS_PUBLIC_URL = 'https://felix-lin.coco.site';
    const uri = buildRedirectUri(mockReq());
    expect(uri).toBe('https://felix-lin.coco.site/auth/callback');
  });

  it('falls back to headers when MSTEAMS_PUBLIC_URL not set', () => {
    const uri = buildRedirectUri(mockReq({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'felix-lin.coco.site',
    }));
    expect(uri).toBe('https://felix-lin.coco.site/auth/callback');
  });

  it('includes X-Forwarded-Prefix in header fallback', () => {
    const uri = buildRedirectUri(mockReq({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'felix-lin.coco.site',
      'x-forwarded-prefix': '/ms-teams',
    }));
    expect(uri).toBe('https://felix-lin.coco.site/ms-teams/auth/callback');
  });

  it('strips trailing slash from X-Forwarded-Prefix', () => {
    const uri = buildRedirectUri(mockReq({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'felix-lin.coco.site',
      'x-forwarded-prefix': '/ms-teams/',
    }));
    expect(uri).toBe('https://felix-lin.coco.site/ms-teams/auth/callback');
  });

  it('falls back to req.protocol and host header when no forwarding headers', () => {
    const uri = buildRedirectUri(mockReq());
    expect(uri).toBe('http://localhost:3978/auth/callback');
  });

  it('falls back to headers when MSTEAMS_PUBLIC_URL is not HTTPS', () => {
    process.env.MSTEAMS_PUBLIC_URL = 'http://example.com/ms-teams';
    const uri = buildRedirectUri(mockReq({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'felix-lin.coco.site',
      'x-forwarded-prefix': '/ms-teams',
    }));
    expect(uri).toBe('https://felix-lin.coco.site/ms-teams/auth/callback');
  });

  // X-Forwarded-Prefix rejection cases
  it('rejects protocol-relative prefix (//evil.com)', () => {
    const uri = buildRedirectUri(mockReq({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'felix-lin.coco.site',
      'x-forwarded-prefix': '//evil.com',
    }));
    expect(uri).toBe('https://felix-lin.coco.site/auth/callback');
  });

  it('rejects prefix with query string', () => {
    const uri = buildRedirectUri(mockReq({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'felix-lin.coco.site',
      'x-forwarded-prefix': '/ms-teams?redirect=evil',
    }));
    expect(uri).toBe('https://felix-lin.coco.site/auth/callback');
  });

  it('rejects prefix with fragment', () => {
    const uri = buildRedirectUri(mockReq({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'felix-lin.coco.site',
      'x-forwarded-prefix': '/ms-teams#fragment',
    }));
    expect(uri).toBe('https://felix-lin.coco.site/auth/callback');
  });

  it('rejects prefix with percent-encoding', () => {
    const uri = buildRedirectUri(mockReq({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'felix-lin.coco.site',
      'x-forwarded-prefix': '/ms-teams%2f..%2f',
    }));
    expect(uri).toBe('https://felix-lin.coco.site/auth/callback');
  });

  it('rejects prefix with dot-segments', () => {
    const uri = buildRedirectUri(mockReq({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'felix-lin.coco.site',
      'x-forwarded-prefix': '/ms-teams/../admin',
    }));
    expect(uri).toBe('https://felix-lin.coco.site/auth/callback');
  });

  it('rejects prefix with backslash', () => {
    const uri = buildRedirectUri(mockReq({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'felix-lin.coco.site',
      'x-forwarded-prefix': '/ms-teams\\..\\admin',
    }));
    expect(uri).toBe('https://felix-lin.coco.site/auth/callback');
  });

  it('rejects prefix not starting with /', () => {
    const uri = buildRedirectUri(mockReq({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'felix-lin.coco.site',
      'x-forwarded-prefix': 'ms-teams',
    }));
    expect(uri).toBe('https://felix-lin.coco.site/auth/callback');
  });

  it('rejects prefix with control characters', () => {
    const uri = buildRedirectUri(mockReq({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'felix-lin.coco.site',
      'x-forwarded-prefix': '/ms-teams\r\nInjected: header',
    }));
    expect(uri).toBe('https://felix-lin.coco.site/auth/callback');
  });
});
