import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const LOGS_DIR = path.join(DATA_DIR, 'logs');
const BYTES_PER_ENTRY = 512;
const _replayedKeys = new Set();

fs.mkdirSync(LOGS_DIR, { recursive: true });

function chatIdToLogFile(chatId) {
  return String(chatId).split(';')[0].replace(/[/:@]/g, '_') + '.jsonl';
}

export function logEntry(chatId, entry) {
  const logFile = path.join(LOGS_DIR, chatIdToLogFile(chatId));
  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error(`[teams] Log write failed for ${chatId}: ${err.message}`);
  }
}

export function ensureReplay(chatId, recordFn, limit = 10) {
  const key = String(chatId);
  if (_replayedKeys.has(key)) return;

  const logFile = path.join(LOGS_DIR, chatIdToLogFile(key));
  if (!fs.existsSync(logFile)) {
    _replayedKeys.add(key);
    return;
  }

  try {
    const stat = fs.statSync(logFile);
    const readSize = Math.min(stat.size, limit * BYTES_PER_ENTRY * 2);
    let content;
    if (readSize < stat.size) {
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(logFile, 'r');
      try {
        fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      } finally {
        fs.closeSync(fd);
      }
      const text = buf.toString('utf-8');
      const firstNewline = text.indexOf('\n');
      content = firstNewline !== -1 ? text.substring(firstNewline + 1) : text;
    } else {
      content = fs.readFileSync(logFile, 'utf-8');
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
      console.log(`[teams] Replayed ${tail.length} log entries for ${key}`);
    }
  } catch (err) {
    console.error(`[teams] Log replay failed for ${key}: ${err.message}`);
  }
}
