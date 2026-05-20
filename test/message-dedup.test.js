import { describe, it, expect } from 'vitest';
import { createMessageDeduper, MESSAGE_DEDUP_TTL_MS, MESSAGE_DEDUP_SWEEP_THRESHOLD } from '../src/lib/message-dedup.js';

describe('createMessageDeduper', () => {
  it('returns false for a new message', () => {
    const dedup = createMessageDeduper();
    expect(dedup.checkAndMark('msg-1')).toBe(false);
  });

  it('returns true for a duplicate within TTL', () => {
    const dedup = createMessageDeduper();
    dedup.checkAndMark('msg-1');
    expect(dedup.checkAndMark('msg-1')).toBe(true);
  });

  it('returns false for null/undefined/empty messageId', () => {
    const dedup = createMessageDeduper();
    expect(dedup.checkAndMark(null)).toBe(false);
    expect(dedup.checkAndMark(undefined)).toBe(false);
    expect(dedup.checkAndMark('')).toBe(false);
  });

  it('returns false after TTL expires', () => {
    let time = 1000;
    const dedup = createMessageDeduper({ ttlMs: 100, now: () => time });
    dedup.checkAndMark('msg-1');
    time = 1200;
    expect(dedup.checkAndMark('msg-1')).toBe(false);
  });

  it('removes expired entry and re-adds on re-check after TTL', () => {
    let time = 1000;
    const dedup = createMessageDeduper({ ttlMs: 100, now: () => time });
    dedup.checkAndMark('msg-1');
    expect(dedup.size()).toBe(1);
    time = 1200;
    expect(dedup.checkAndMark('msg-1')).toBe(false);
    expect(dedup.size()).toBe(1);
  });

  it('calls logDuplicate on duplicate', () => {
    const logged = [];
    const dedup = createMessageDeduper({ logDuplicate: (id) => logged.push(id) });
    dedup.checkAndMark('msg-1');
    dedup.checkAndMark('msg-1');
    expect(logged).toEqual(['msg-1']);
  });

  it('triggers sweep when exceeding threshold', () => {
    let time = 1000;
    const dedup = createMessageDeduper({ ttlMs: 50, sweepThreshold: 3, now: () => time });
    dedup.checkAndMark('a');
    dedup.checkAndMark('b');
    dedup.checkAndMark('c');
    expect(dedup.size()).toBe(3);
    time = 1100;
    dedup.checkAndMark('d');
    expect(dedup.size()).toBe(1);
  });

  it('sweepExpired removes only expired entries', () => {
    let time = 1000;
    const dedup = createMessageDeduper({ ttlMs: 100, now: () => time });
    dedup.checkAndMark('old');
    time = 1050;
    dedup.checkAndMark('new');
    time = 1150;
    dedup.sweepExpired();
    expect(dedup.size()).toBe(1);
  });

  it('exports correct default constants', () => {
    expect(MESSAGE_DEDUP_TTL_MS).toBe(5 * 60 * 1000);
    expect(MESSAGE_DEDUP_SWEEP_THRESHOLD).toBe(200);
  });
});
