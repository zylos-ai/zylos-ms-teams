import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSentMessageCache,
  isSentMessage,
  recordSentMessage,
  sweepSentMessageCache,
} from '../src/lib/sent-message-cache.js';

describe('sent message cache', () => {
  beforeEach(() => {
    clearSentMessageCache();
    vi.useRealTimers();
  });

  it('records and detects sent message IDs by conversation', () => {
    expect(recordSentMessage('conv-1', 'msg-1')).toBe(true);
    expect(isSentMessage('conv-1', 'msg-1')).toBe(true);
    expect(isSentMessage('conv-2', 'msg-1')).toBe(false);
  });

  it('normalizes thread conversation IDs to the base conversation', () => {
    recordSentMessage('conv-1;messageid=root', 'msg-1');
    expect(isSentMessage('conv-1', 'msg-1')).toBe(true);
    expect(isSentMessage('conv-1;messageid=root', 'msg-1')).toBe(true);
  });

  it('rejects missing IDs', () => {
    expect(recordSentMessage('', 'msg-1')).toBe(false);
    expect(recordSentMessage('conv-1', '')).toBe(false);
    expect(isSentMessage('', 'msg-1')).toBe(false);
  });

  it('expires old entries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T00:00:00Z'));
    recordSentMessage('conv-1', 'old', { ttlMs: 100 });
    vi.advanceTimersByTime(101);
    expect(isSentMessage('conv-1', 'old', { ttlMs: 100 })).toBe(false);
  });

  it('sweeps expired entries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T00:00:00Z'));
    recordSentMessage('conv-1', 'old', { ttlMs: 100 });
    vi.advanceTimersByTime(101);
    sweepSentMessageCache(100);
    expect(isSentMessage('conv-1', 'old', { ttlMs: 100 })).toBe(false);
  });
});
