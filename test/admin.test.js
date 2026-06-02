import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('admin CLI', () => {
  let tmpDir;
  let configPath;
  const adminPath = path.resolve('src/admin.js');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-teams-admin-'));
    const dataDir = path.join(tmpDir, 'zylos/components/ms-teams');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'zylos'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'zylos/.env'), '');
    configPath = path.join(dataDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runAdmin(args) {
    return execFileSync(process.execPath, [adminPath, ...args], {
      env: { ...process.env, HOME: tmpDir },
      encoding: 'utf8',
    });
  }

  it('updates mode when add-group is run for an existing group', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      groups: {
        'group-1': {
          name: 'Old Name',
          mode: 'smart',
          allowFrom: ['aad-1'],
        },
      },
    }));

    const output = runAdmin(['add-group', 'group-1', 'New Name', 'mention']);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(output).toContain('updating name and mode');
    expect(config.groups['group-1'].name).toBe('New Name');
    expect(config.groups['group-1'].mode).toBe('mention');
    expect(config.groups['group-1'].allowFrom).toEqual(['aad-1']);
  });
});
