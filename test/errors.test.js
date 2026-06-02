import { describe, expect, it } from 'vitest';
import { appendErrorHint, classifyApiError } from '../src/lib/errors.js';

describe('error classification', () => {
  it('classifies auth failures with actionable hints', () => {
    const result = classifyApiError({ status: 403 });

    expect(result.class).toBe('auth');
    expect(result.hint).toContain('Azure Portal');
  });

  it('includes retry-after details for throttling', () => {
    const message = appendErrorHint('Graph API error (429): throttled', {
      status: 429,
      headers: { 'retry-after': '30' },
    });

    expect(message).toContain('throttle');
    expect(message).toContain('retry-after: 30s');
  });

  it('classifies network-shaped errors', () => {
    const result = classifyApiError({ error: new Error('fetch failed: ECONNRESET') });

    expect(result.class).toBe('network');
  });
});
