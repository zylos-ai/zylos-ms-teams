import fs from 'node:fs';
import path from 'node:path';

export function writeJsonAtomic(filePath, data, mode = 0o644) {
  const tmp = filePath + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, filePath);
}
