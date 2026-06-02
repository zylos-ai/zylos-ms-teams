import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearThreadParentCache,
  getCachedThreadParent,
  markThreadParentInjected,
  shouldInjectThreadParent,
} from '../src/lib/thread-parent-cache.js';

describe('thread parent cache', () => {
  beforeEach(() => {
    clearThreadParentCache();
    vi.useRealTimers();
  });

  it('caches fetched parent messages', async () => {
    const parent = { id: 'root-1' };
    const fetcher = vi.fn().mockResolvedValue(parent);

    await expect(getCachedThreadParent('team-1', 'channel-1', 'root-1', fetcher)).resolves.toBe(parent);
    await expect(getCachedThreadParent('team-1', 'channel-1', 'root-1', fetcher)).resolves.toBe(parent);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('expires cached parent messages by TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T00:00:00Z'));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ id: 'first' })
      .mockResolvedValueOnce({ id: 'second' });

    await expect(getCachedThreadParent('team-1', 'channel-1', 'root-1', fetcher, { ttlMs: 100 })).resolves.toEqual({ id: 'first' });
    vi.advanceTimersByTime(101);
    await expect(getCachedThreadParent('team-1', 'channel-1', 'root-1', fetcher, { ttlMs: 100 })).resolves.toEqual({ id: 'second' });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tracks one parent injection per thread session', () => {
    expect(shouldInjectThreadParent('channel-1;messageid=root-1', 'root-1')).toBe(true);
    expect(markThreadParentInjected('channel-1;messageid=root-1', 'root-1')).toBe(true);
    expect(shouldInjectThreadParent('channel-1;messageid=root-1', 'root-1')).toBe(false);
    expect(shouldInjectThreadParent('channel-1;messageid=root-2', 'root-2')).toBe(true);
  });

  it('does not cache null parent fetch results', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'root-1' });

    await expect(getCachedThreadParent('team-1', 'channel-1', 'root-1', fetcher)).resolves.toBeNull();
    await expect(getCachedThreadParent('team-1', 'channel-1', 'root-1', fetcher)).resolves.toEqual({ id: 'root-1' });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects empty thread injection keys', () => {
    expect(shouldInjectThreadParent('', '')).toBe(false);
    expect(markThreadParentInjected('', '')).toBe(false);
  });

  it('expires injected parent dedup keys', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T00:00:00Z'));

    markThreadParentInjected('channel-1;messageid=root-1', 'root-1');
    expect(shouldInjectThreadParent('channel-1;messageid=root-1', 'root-1', { ttlMs: 100 })).toBe(false);
    vi.advanceTimersByTime(101);
    expect(shouldInjectThreadParent('channel-1;messageid=root-1', 'root-1', { ttlMs: 100 })).toBe(true);
  });
});
