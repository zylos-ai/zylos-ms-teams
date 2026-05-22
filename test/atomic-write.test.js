import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeJsonAtomic } from '../src/lib/atomic-write.js';

describe('writeJsonAtomic', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes valid JSON that can be read back', () => {
    const filePath = path.join(tmpDir, 'test.json');
    const data = { key: 'value', nested: { a: 1 } };
    writeJsonAtomic(filePath, data);
    const result = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(result).toEqual(data);
  });

  it('produces readable JSON with indentation', () => {
    const filePath = path.join(tmpDir, 'test.json');
    writeJsonAtomic(filePath, { a: 1 });
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('\n');
    expect(content).toContain('  ');
  });

  it('creates parent directories if they do not exist', () => {
    const filePath = path.join(tmpDir, 'sub', 'dir', 'test.json');
    writeJsonAtomic(filePath, { ok: true });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ ok: true });
  });

  it('overwrites existing file atomically', () => {
    const filePath = path.join(tmpDir, 'test.json');
    writeJsonAtomic(filePath, { version: 1 });
    writeJsonAtomic(filePath, { version: 2 });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 2 });
  });

  it('does not leave .tmp file on success', () => {
    const filePath = path.join(tmpDir, 'test.json');
    writeJsonAtomic(filePath, { clean: true });
    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
  });

  it('applies custom file mode', () => {
    const filePath = path.join(tmpDir, 'secret.json');
    writeJsonAtomic(filePath, { secret: true }, 0o600);
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
