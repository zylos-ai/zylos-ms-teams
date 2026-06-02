import fs from 'node:fs';
import path from 'node:path';

export function writeJsonAtomic(filePath, data, mode = 0o644) {
  const tmp = filePath + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.unlinkSync(tmp);
  } catch {}
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
}
