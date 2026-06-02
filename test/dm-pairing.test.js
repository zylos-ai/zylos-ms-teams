import { describe, expect, it } from 'vitest';
import {
  approvePairingUser,
  buildPairingNotification,
  denyPairingUser,
  getPairingStatus,
  markPairingPending,
} from '../src/lib/dm-pairing.js';

describe('DM pairing state', () => {
  it('moves users from pending to approved allowlist', () => {
    const config = { dmAllowFrom: [] };
    const state = { pending: {}, denied: {} };

    markPairingPending({ userId: 'user-1', userName: 'Felix', conversationId: 'conv-1' }, state);
    expect(getPairingStatus('user-1', state)).toBe('pending');

    approvePairingUser(config, 'user-1', state);

    expect(config.dmAllowFrom).toEqual(['user-1']);
    expect(getPairingStatus('user-1', state)).toBe('unknown');
  });

  it('tracks denied users and removes them from allowlist', () => {
    const config = { dmAllowFrom: ['user-1'] };
    const state = { pending: { 'user-1': { userId: 'user-1' } }, denied: {} };

    denyPairingUser(config, 'user-1', 'no access', state);

    expect(config.dmAllowFrom).toEqual([]);
    expect(getPairingStatus('user-1', state)).toBe('denied');
  });

  it('builds C4 admin notification text', () => {
    const message = buildPairingNotification({
      userId: 'user-1',
      userName: 'Felix',
      conversationId: 'conv-1',
      firstMessage: 'hello',
    });

    expect(message).toContain('[Teams DM Pairing Request]');
    expect(message).toContain('zylos-ms-teams dm-approve user-1');
  });
});
