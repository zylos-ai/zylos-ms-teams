import { describe, expect, it, vi } from 'vitest';
import { createAccessControl } from '../src/lib/access.js';

vi.mock('../src/lib/config.js', () => ({
  saveConfig: vi.fn(() => true),
}));

describe('access control', () => {
  it('rejects all DMs when dmPolicy is disabled, including owner', () => {
    const access = createAccessControl(() => ({
      owner: {
        bound: true,
        aadObjectId: 'owner-aad',
        name: 'Owner',
      },
      dmPolicy: 'disabled',
      dmAllowFrom: ['allowed-aad'],
    }));

    expect(access.isDmAllowed('owner-aad', 'Owner')).toBe(false);
    expect(access.isDmAllowed('allowed-aad', 'Allowed User')).toBe(false);
  });
});
