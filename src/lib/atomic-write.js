import fs from 'node:fs';
import path from 'node:path';

/**
 * Write JSON atomically: write a temp file and rename it over the target.
 * With `durable: true`, also fsync the temp file before the rename and the
 * directory after it, so the write survives power loss. fsync blocks the
 * event loop, so enable it only for state that must not be lost (session
 * groups, config, tokens), not for hot-path caches.
 * @param {string} filePath
 * @param {*} data
 * @param {number} [mode=0o644]
 * @param {object} [opts]
 * @param {boolean} [opts.durable=false]
 */
export function writeJsonAtomic(filePath, data, mode = 0o644, { durable = false } = {}) {
  const tmp = filePath + '.tmp';
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.unlinkSync(tmp);
  } catch {}
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    if (durable) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
  if (!durable) return;
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* directory fsync unsupported on this platform */ }
}
