import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageDeduper } from '../src/lib/message-dedup.js';

test('blocks duplicate within TTL window', () => {
  let now = 1000;
  const dupes = [];
  const deduper = createMessageDeduper({
    ttlMs: 5000,
    now: () => now,
    logDuplicate: (id) => dupes.push(id),
  });

  assert.equal(deduper.checkAndMark('msg-1'), false);
  now += 100;
  assert.equal(deduper.checkAndMark('msg-1'), true);
  assert.deepEqual(dupes, ['msg-1']);
});

test('allows same message after TTL expires', () => {
  let now = 10000;
  const deduper = createMessageDeduper({
    ttlMs: 5000,
    now: () => now,
  });

  assert.equal(deduper.checkAndMark('msg-2'), false);
  now += 5001;
  assert.equal(deduper.checkAndMark('msg-2'), false);
});

test('sweepExpired removes old entries and keeps recent ones', () => {
  let now = 20000;
  const deduper = createMessageDeduper({
    ttlMs: 5000,
    now: () => now,
  });

  deduper.checkAndMark('old');
  now += 2000;
  deduper.checkAndMark('recent');
  now += 3001;

  deduper.sweepExpired();
  assert.equal(deduper.size(), 1);
  assert.equal(deduper.checkAndMark('old'), false);
  assert.equal(deduper.checkAndMark('recent'), true);
});

test('ignores empty or null message IDs', () => {
  const deduper = createMessageDeduper();
  assert.equal(deduper.checkAndMark(''), false);
  assert.equal(deduper.checkAndMark(null), false);
  assert.equal(deduper.size(), 0);
});

test('distinct messages are independent', () => {
  const deduper = createMessageDeduper();
  assert.equal(deduper.checkAndMark('a'), false);
  assert.equal(deduper.checkAndMark('b'), false);
  assert.equal(deduper.checkAndMark('a'), true);
  assert.equal(deduper.checkAndMark('b'), true);
  assert.equal(deduper.size(), 2);
});
