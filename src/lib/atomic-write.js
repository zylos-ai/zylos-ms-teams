import fs from 'node:fs';
import path from 'node:path';

/**
 * Write JSON atomically and durably: write a temp file, fsync it, rename it
 * over the target, then fsync the directory so the rename survives power loss.
 */
export function writeJsonAtomic(filePath, data, mode = 0o644) {
  const tmp = filePath + '.tmp';
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.unlinkSync(tmp);
  } catch {}
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* directory fsync unsupported on this platform */ }
}
