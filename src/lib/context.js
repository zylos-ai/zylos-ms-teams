import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const LOGS_DIR = path.join(DATA_DIR, 'logs');
const BYTES_PER_ENTRY = 512;
const _replayedKeys = new Set();

fs.mkdirSync(LOGS_DIR, { recursive: true });

function chatIdToLogFile(chatId) {
  return String(chatId).split(';')[0].replace(/[/:@]/g, '_') + '.jsonl';
}

const _writeQueues = new Map();

export function logEntry(chatId, entry) {
  const logFile = path.join(LOGS_DIR, chatIdToLogFile(chatId));
  const prev = _writeQueues.get(logFile) || Promise.resolve();
  const next = prev.then(() =>
    fsp.appendFile(logFile, JSON.stringify(entry) + '\n')
  ).catch(err => {
    console.error(`[ms-teams] Log write failed for ${chatId}: ${err.message}`);
  });
  _writeQueues.set(logFile, next);
}

export async function ensureReplay(chatId, recordFn, limit = 10) {
  const key = String(chatId);
  if (_replayedKeys.has(key)) return;

  const logFile = path.join(LOGS_DIR, chatIdToLogFile(key));
  try {
    await fsp.access(logFile);
  } catch {
    _replayedKeys.add(key);
    return;
  }

  try {
    const stat = await fsp.stat(logFile);
    const readSize = Math.min(stat.size, limit * BYTES_PER_ENTRY * 2);
    let content;
    if (readSize < stat.size) {
      const buf = Buffer.alloc(readSize);
      const fh = await fsp.open(logFile, 'r');
      try {
        await fh.read(buf, 0, readSize, stat.size - readSize);
      } finally {
        await fh.close();
      }
      const text = buf.toString('utf-8');
      const firstNewline = text.indexOf('\n');
      content = firstNewline !== -1 ? text.substring(firstNewline + 1) : text;
    } else {
      content = await fsp.readFile(logFile, 'utf-8');
    }
    const lines = content.trim().split('\n').filter(l => l);
    const tail = lines.slice(-limit);

    for (const line of tail) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      recordFn(key, entry);
    }

    _replayedKeys.add(key);
    if (tail.length > 0) {
      console.log(`[ms-teams] Replayed ${tail.length} log entries for ${key}`);
    }

    // Truncate log to just the tail entries we replayed
    if (tail.length < lines.length) {
      const trimmed = tail.map(l => l.endsWith('\n') ? l : l + '\n').join('');
      await fsp.writeFile(logFile, trimmed);
      console.log(`[ms-teams] Truncated log for ${key}: ${lines.length} → ${tail.length} entries`);
    }
  } catch (err) {
    console.error(`[ms-teams] Log replay failed for ${key}: ${err.message}`);
  }
}
