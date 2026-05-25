import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('configure hook', () => {
  let tmpDir;
  let configPath;
  let envPath;
  const hookPath = path.resolve('hooks/configure.js');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-teams-configure-'));
    const dataDir = path.join(tmpDir, 'zylos/components/ms-teams');
    fs.mkdirSync(dataDir, { recursive: true });
    configPath = path.join(dataDir, 'config.json');
    envPath = path.join(tmpDir, 'zylos/.env');
    fs.writeFileSync(envPath, 'EXISTING_VAR=keep\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runConfigure(input) {
    return execFileSync('node', [hookPath], {
      input: JSON.stringify(input),
      env: { ...process.env, HOME: tmpDir },
      encoding: 'utf8',
    });
  }

  it('stores credentials in config.json only', () => {
    runConfigure({
      MSTEAMS_APP_ID: 'test-app-id',
      MSTEAMS_APP_PASSWORD: 'test-secret',
      MSTEAMS_TENANT_ID: 'test-tenant',
    });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.credentials.appId).toBe('test-app-id');
    expect(config.credentials.appPassword).toBe('test-secret');
    expect(config.credentials.tenantId).toBe('test-tenant');
  });

  it('does not write credentials to .env', () => {
    runConfigure({
      MSTEAMS_APP_ID: 'test-app-id',
      MSTEAMS_APP_PASSWORD: 'test-secret',
    });

    const envContent = fs.readFileSync(envPath, 'utf8');
    expect(envContent).toBe('EXISTING_VAR=keep\n');
    expect(envContent).not.toContain('MSTEAMS_APP_ID');
    expect(envContent).not.toContain('MSTEAMS_APP_PASSWORD');
  });

  it('stores MSTEAMS_PUBLIC_URL as publicUrl in config', () => {
    runConfigure({
      MSTEAMS_APP_ID: 'test-app-id',
      MSTEAMS_APP_PASSWORD: 'test-secret',
      MSTEAMS_PUBLIC_URL: 'https://bot.example.com/ms-teams',
    });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.publicUrl).toBe('https://bot.example.com/ms-teams');
  });

  it('preserves existing config fields', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      enabled: true,
      port: 3978,
      dmPolicy: 'open',
      groups: { 'grp-1': { name: 'Test' } },
    }));

    runConfigure({ MSTEAMS_APP_ID: 'new-id' });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.dmPolicy).toBe('open');
    expect(config.groups['grp-1'].name).toBe('Test');
    expect(config.credentials.appId).toBe('new-id');
  });

  it('skips empty/null values', () => {
    runConfigure({
      MSTEAMS_APP_ID: 'test-id',
      MSTEAMS_APP_PASSWORD: '',
      MSTEAMS_TENANT_ID: null,
    });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.credentials.appId).toBe('test-id');
    expect(config.credentials).not.toHaveProperty('appPassword');
    expect(config.credentials).not.toHaveProperty('tenantId');
  });
});
