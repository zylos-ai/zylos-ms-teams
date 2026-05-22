import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir;
let mod;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs-test-'));
  vi.stubEnv('HOME', tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'zylos/components/ms-teams'), { recursive: true });

  vi.doUnmock('../src/lib/channel-subscriptions.js');
  vi.resetModules();

  vi.doMock('../src/lib/config.js', () => ({
    DATA_DIR: path.join(tmpDir, 'zylos/components/ms-teams'),
    getCredentials: () => ({ appId: 'test', appPassword: 'test', tenantId: 'test-tenant' }),
  }));
  vi.doMock('../src/lib/graph.js', () => ({
    acquireTokenForScope: vi.fn(),
    graphRequest: vi.fn(),
  }));

  mod = await import('../src/lib/channel-subscriptions.js');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('getClientState', () => {
  it('generates and persists a random secret on first call', () => {
    const state = mod.getClientState();
    expect(typeof state).toBe('string');
    expect(state.length).toBe(64);
    const stateFile = path.join(tmpDir, 'zylos/components/ms-teams/subscription-client-state');
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(fs.readFileSync(stateFile, 'utf8').trim()).toBe(state);
  });

  it('returns the same value on subsequent calls', () => {
    const first = mod.getClientState();
    const second = mod.getClientState();
    expect(first).toBe(second);
  });
});

describe('validateClientState', () => {
  it('returns true for matching clientState', () => {
    const state = mod.getClientState();
    expect(mod.validateClientState(state)).toBe(true);
  });

  it('returns false for wrong clientState', () => {
    mod.getClientState();
    expect(mod.validateClientState('wrong-value')).toBe(false);
  });

  it('returns false for empty string', () => {
    mod.getClientState();
    expect(mod.validateClientState('')).toBe(false);
  });

  it('returns false for null', () => {
    mod.getClientState();
    expect(mod.validateClientState(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    mod.getClientState();
    expect(mod.validateClientState(undefined)).toBe(false);
  });
});
