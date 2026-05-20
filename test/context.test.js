import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
const LOGS_DIR = path.join(HOME, 'zylos/components/ms-teams/logs');

// Test-specific log file to avoid interfering with real data
const TEST_CHAT_ID = '__vitest_context_test__';
const TEST_LOG_FILE = path.join(LOGS_DIR, `${TEST_CHAT_ID}.jsonl`);

import { logEntry, ensureReplay } from '../src/lib/context.js';

describe('logEntry (async)', () => {
  beforeEach(() => {
    try { fs.unlinkSync(TEST_LOG_FILE); } catch {}
  });

  afterEach(() => {
    try { fs.unlinkSync(TEST_LOG_FILE); } catch {}
  });

  it('writes a JSONL entry to the log file', async () => {
    const entry = { timestamp: '2026-01-01T00:00:00Z', text: 'hello', user_id: 'u1' };
    logEntry(TEST_CHAT_ID, entry);
    // logEntry is fire-and-forget async, wait briefly for write
    await new Promise(r => setTimeout(r, 100));
    const content = fs.readFileSync(TEST_LOG_FILE, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.text).toBe('hello');
    expect(parsed.user_id).toBe('u1');
  });

  it('appends multiple entries', async () => {
    logEntry(TEST_CHAT_ID, { text: 'first' });
    logEntry(TEST_CHAT_ID, { text: 'second' });
    await new Promise(r => setTimeout(r, 200));
    const lines = fs.readFileSync(TEST_LOG_FILE, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).text).toBe('first');
    expect(JSON.parse(lines[1]).text).toBe('second');
  });
});

describe('ensureReplay (async)', () => {
  const REPLAY_CHAT_ID = '__vitest_replay_test__';
  const REPLAY_LOG_FILE = path.join(LOGS_DIR, `${REPLAY_CHAT_ID}.jsonl`);

  beforeEach(() => {
    try { fs.unlinkSync(REPLAY_LOG_FILE); } catch {}
  });

  afterEach(() => {
    try { fs.unlinkSync(REPLAY_LOG_FILE); } catch {}
  });

  it('replays entries from a log file', async () => {
    const entries = [
      { timestamp: '2026-01-01T00:00:01Z', text: 'msg1', message_id: 'm1' },
      { timestamp: '2026-01-01T00:00:02Z', text: 'msg2', message_id: 'm2' },
      { timestamp: '2026-01-01T00:00:03Z', text: 'msg3', message_id: 'm3' },
    ];
    fs.writeFileSync(REPLAY_LOG_FILE, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    const replayed = [];
    // ensureReplay uses an internal Set to prevent double-replay,
    // so we use a unique chat ID each test
    await ensureReplay(REPLAY_CHAT_ID, (chatId, entry) => {
      replayed.push(entry);
    }, 10);

    expect(replayed.length).toBe(3);
    expect(replayed[0].text).toBe('msg1');
    expect(replayed[2].text).toBe('msg3');
  });

  it('respects the limit parameter', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      text: `msg${i}`,
      message_id: `m${i}`,
    }));
    fs.writeFileSync(REPLAY_LOG_FILE + '2', entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    const replayed = [];
    const chatId = '__vitest_replay_limit__';
    const logFile = path.join(LOGS_DIR, `${chatId}.jsonl`);
    fs.writeFileSync(logFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    await ensureReplay(chatId, (_, entry) => {
      replayed.push(entry);
    }, 5);

    expect(replayed.length).toBe(5);
    expect(replayed[4].text).toBe('msg19');

    try { fs.unlinkSync(logFile); } catch {}
    try { fs.unlinkSync(REPLAY_LOG_FILE + '2'); } catch {}
  });

  it('truncates log file to tail entries after replay', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      timestamp: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
      text: `line${i}`,
      message_id: `trunc-${i}`,
    }));
    const chatId = '__vitest_replay_truncate__';
    const logFile = path.join(LOGS_DIR, `${chatId}.jsonl`);
    fs.writeFileSync(logFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    await ensureReplay(chatId, () => {}, 5);

    const after = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(after.length).toBe(5);
    expect(JSON.parse(after[0]).text).toBe('line45');
    expect(JSON.parse(after[4]).text).toBe('line49');

    try { fs.unlinkSync(logFile); } catch {}
  });

  it('handles missing log file gracefully', async () => {
    const replayed = [];
    const chatId = '__vitest_replay_missing__';
    await ensureReplay(chatId, (_, entry) => {
      replayed.push(entry);
    }, 10);
    expect(replayed.length).toBe(0);
  });
});
