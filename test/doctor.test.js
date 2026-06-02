import { describe, expect, it, vi } from 'vitest';
import { formatDoctorReport, runDoctor } from '../src/lib/doctor.js';

describe('doctor', () => {
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

    const results = await runDoctor({
      enabled: true,
      cloud: 'public',
      port: 3978,
      channels: { ch1: { mode: 'smart', teamId: 'team-1' } },
      groups: { '19:group@thread.v2': { name: 'Group' } },
    }, { fetchImpl, tokenProbe, subscriptionsProvider });

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
      subscriptionsProvider: vi.fn().mockReturnValue({}),
    });

    const teamIdCheck = results.find(result => result.name === 'smart channel team IDs');
    expect(teamIdCheck.ok).toBe(false);
    expect(teamIdCheck.detail).toBe('1 missing teamId');
  });
});
