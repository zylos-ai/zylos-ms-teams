import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { timedFetch, safeFetch } from '../src/lib/fetch-utils.js';

describe('timedFetch', () => {
  it('returns response on success', async () => {
    const mockRes = new Response('ok', { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockRes));
    const res = await timedFetch('https://example.com', {}, 5000);
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith('https://example.com', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    vi.unstubAllGlobals();
  });

  it('passes options through to fetch', async () => {
    const mockRes = new Response('ok', { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockRes));
    await timedFetch('https://example.com', {
      method: 'POST',
      headers: { 'X-Test': 'yes' },
    }, 5000);
    expect(fetch).toHaveBeenCalledWith('https://example.com', expect.objectContaining({
      method: 'POST',
      headers: { 'X-Test': 'yes' },
    }));
    vi.unstubAllGlobals();
  });
});

describe('safeFetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ALLOW_HOSTS = ['example.com', 'graph.microsoft.com', 'sharepoint.com'];

  it('returns response directly for non-redirect status', async () => {
    fetch.mockResolvedValue(new Response('ok', { status: 200 }));
    const res = await safeFetch('https://example.com/file', {}, { allowHosts: ALLOW_HOSTS });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('https://example.com/file', expect.objectContaining({
      redirect: 'manual',
    }));
  });

  it('follows redirect to allowed host', async () => {
    fetch
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: 'https://graph.microsoft.com/resource' },
      }))
      .mockResolvedValueOnce(new Response('data', { status: 200 }));
    const res = await safeFetch('https://example.com/file', {}, { allowHosts: ALLOW_HOSTS });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects redirect to disallowed host', async () => {
    fetch.mockResolvedValue(new Response(null, {
      status: 301,
      headers: { Location: 'https://evil.com/steal' },
    }));
    await expect(
      safeFetch('https://example.com/file', {}, { allowHosts: ALLOW_HOSTS })
    ).rejects.toThrow('Redirect to disallowed host');
  });

  it('rejects redirect to HTTP (non-HTTPS)', async () => {
    fetch.mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'http://graph.microsoft.com/resource' },
    }));
    await expect(
      safeFetch('https://example.com/file', {}, { allowHosts: ALLOW_HOSTS })
    ).rejects.toThrow('Redirect to non-HTTPS URL');
  });

  it('rejects redirect to private IP', async () => {
    fetch.mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'https://192.168.1.1/internal' },
    }));
    await expect(
      safeFetch('https://example.com/file', {}, { allowHosts: ALLOW_HOSTS })
    ).rejects.toThrow('Redirect to disallowed host');
  });

  it('follows chained redirects within allowed hosts', async () => {
    fetch
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: 'https://graph.microsoft.com/step1' },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: 'https://cdn.sharepoint.com/final' },
      }))
      .mockResolvedValueOnce(new Response('data', { status: 200 }));
    const res = await safeFetch('https://example.com/file', {}, { allowHosts: ALLOW_HOSTS });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('throws on too many redirects', async () => {
    fetch.mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'https://example.com/loop' },
    }));
    await expect(
      safeFetch('https://example.com/start', {}, { allowHosts: ALLOW_HOSTS, maxRedirects: 2 })
    ).rejects.toThrow('Too many redirects');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('resolves relative redirect URLs (same origin)', async () => {
    fetch
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: '/other-path' },
      }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await safeFetch('https://example.com/start', {}, { allowHosts: ALLOW_HOSTS });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe('https://example.com/other-path');
  });

  it('returns 4xx response without following', async () => {
    fetch.mockResolvedValue(new Response('not found', { status: 404 }));
    const res = await safeFetch('https://example.com/missing', {}, { allowHosts: ALLOW_HOSTS });
    expect(res.status).toBe(404);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('strips Authorization header on cross-origin redirect', async () => {
    fetch
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: 'https://graph.microsoft.com/file' },
      }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await safeFetch('https://example.com/file', {
      headers: { Authorization: 'Bearer token123', 'Content-Type': 'application/json' },
    }, { allowHosts: ALLOW_HOSTS });
    const redirectCall = fetch.mock.calls[1][1];
    expect(redirectCall.headers).not.toHaveProperty('Authorization');
    expect(redirectCall.headers).not.toHaveProperty('authorization');
    expect(redirectCall.headers['Content-Type']).toBe('application/json');
  });

  it('preserves Authorization header on same-origin redirect', async () => {
    fetch
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: 'https://example.com/other' },
      }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await safeFetch('https://example.com/file', {
      headers: { Authorization: 'Bearer token123' },
    }, { allowHosts: ALLOW_HOSTS });
    const redirectCall = fetch.mock.calls[1][1];
    expect(redirectCall.headers.Authorization).toBe('Bearer token123');
  });

  it('rejects HTTP downgrade even for allowed host', async () => {
    fetch.mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'http://example.com/downgraded' },
    }));
    await expect(
      safeFetch('https://example.com/file', {}, { allowHosts: ALLOW_HOSTS })
    ).rejects.toThrow('Redirect to non-HTTPS URL');
  });
});
