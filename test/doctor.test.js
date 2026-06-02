import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDoctorReport, runDoctor } from '../src/lib/doctor.js';

describe('doctor', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('formats doctor results', () => {
    expect(formatDoctorReport([
      { name: 'app id', ok: true, detail: 'configured' },
      { name: 'tenant id', ok: false, detail: 'missing' },
    ])).toBe('[ok] app id - configured\n[warn] tenant id - missing');
  });

  it('runs diagnostics with injected dependencies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const tokenProbe = vi.fn().mockResolvedValue('token');
    const subscriptionsProvider = vi.fn().mockReturnValue({ ch1: { id: 'sub-1' } });

    const delegatedAuthProbe = vi.fn().mockResolvedValue({ configured: false, results: [] });

    const results = await runDoctor({
      enabled: true,
      cloud: 'public',
      port: 3978,
      channels: { ch1: { mode: 'smart', teamId: 'team-1' } },
      groups: { '19:group@thread.v2': { name: 'Group' } },
    }, { fetchImpl, tokenProbe, delegatedAuthProbe, subscriptionsProvider });

    expect(results.some(result => result.name === 'component enabled' && result.ok)).toBe(true);
    expect(results.some(result => result.name === 'local service health' && result.ok)).toBe(true);
    expect(results.some(result => result.name === 'smart channel team IDs' && result.ok)).toBe(true);
  });

  it('flags smart channels missing team IDs', async () => {
    const results = await runDoctor({
      enabled: true,
      cloud: 'public',
      channels: { ch1: { mode: 'smart' } },
      groups: {},
    }, {
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')),
      tokenProbe: vi.fn(),
      delegatedAuthProbe: vi.fn().mockResolvedValue({ configured: false, results: [] }),
      subscriptionsProvider: vi.fn().mockReturnValue({}),
    });

    const teamIdCheck = results.find(result => result.name === 'smart channel team IDs');
    expect(teamIdCheck.ok).toBe(false);
    expect(teamIdCheck.detail).toBe('1 missing teamId');
  });

  it('audits Graph token scopes and delegated auth', async () => {
    vi.stubEnv('MSTEAMS_APP_ID', 'app-id');
    vi.stubEnv('MSTEAMS_APP_PASSWORD', 'secret');
    vi.stubEnv('MSTEAMS_TENANT_ID', 'tenant');

    const payload = Buffer.from(JSON.stringify({
      roles: ['Chat.Read.All', 'User.Read.All'],
    })).toString('base64url');
    const token = `header.${payload}.signature`;

    const results = await runDoctor({
      enabled: true,
      cloud: 'public',
      port: 3978,
      channels: {},
      groups: {},
    }, {
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
      tokenProbe: vi.fn().mockResolvedValue(token),
      delegatedAuthProbe: vi.fn().mockResolvedValue({
        configured: true,
        results: [{ aadObjectId: 'aad-1', displayName: 'Felix Lin', ok: true, detail: 'delegated token acquired' }],
      }),
      subscriptionsProvider: vi.fn().mockReturnValue({}),
    });

    const scopeAudit = results.find(result => result.name === 'Graph scope audit');
    expect(scopeAudit.ok).toBe(false);
    expect(scopeAudit.detail).toContain('ChannelMessage.Read.All');
    expect(results.some(result => result.name === 'Delegated auth probe: Felix Lin' && result.ok)).toBe(true);
  });
});
