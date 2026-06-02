import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadAllowlistResolution, refreshAllowlistResolution } from '../src/lib/allowlist-resolution.js';

describe('allowlist resolution', () => {
  it('resolves display names and Graph groups, then persists the cache', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-resolution-'));
    const filePath = path.join(tmpDir, 'resolution.json');
    const config = {
      dmAllowFrom: ['Felix Lin', 'aad-direct', '*'],
      groups: {
        group1: { allowFrom: ['group:Engineering'] },
      },
      channels: {
        channel1: { allowFrom: ['Ada Lovelace', 'user-*'] },
      },
    };

    await refreshAllowlistResolution(config, {
      findUsers: vi.fn(async name => [{ id: `aad-${name.toLowerCase().replaceAll(' ', '-')}` }]),
      getMembers: vi.fn(async name => [`aad-group-${name.toLowerCase()}`]),
      filePath,
    });

    const cached = loadAllowlistResolution(filePath);
    expect(cached.users['felix lin']).toEqual(['aad-felix-lin']);
    expect(cached.users['ada lovelace']).toEqual(['aad-ada-lovelace']);
    expect(cached.groups.engineering.members).toEqual(['aad-group-engineering']);
    expect(config._allowlistResolution.users['felix lin']).toEqual(['aad-felix-lin']);
  });
});
