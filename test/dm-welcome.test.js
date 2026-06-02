import { describe, it, expect, vi } from 'vitest';
import { sendDmWelcomeIfFirstSeen } from '../src/lib/dm-welcome.js';

describe('DM welcome', () => {
  it('sends and persists welcome for first contact', async () => {
    const ctx = { send: vi.fn().mockResolvedValue(undefined) };
    const seenUsers = new Set();
    const save = vi.fn();

    const sent = await sendDmWelcomeIfFirstSeen({
      ctx,
      aadObjectId: 'user-1',
      message: 'Welcome',
      seenUsers,
      save,
    });

    expect(sent).toBe(true);
    expect(ctx.send).toHaveBeenCalledWith('Welcome');
    expect(seenUsers.has('user-1')).toBe(true);
    expect(save).toHaveBeenCalledWith(seenUsers);
  });

  it('does not send for already seen users or disabled message', async () => {
    const ctx = { send: vi.fn().mockResolvedValue(undefined) };
    const seenUsers = new Set(['user-1']);

    expect(await sendDmWelcomeIfFirstSeen({ ctx, aadObjectId: 'user-1', message: 'Welcome', seenUsers })).toBe(false);
    expect(await sendDmWelcomeIfFirstSeen({ ctx, aadObjectId: 'user-2', message: '', seenUsers })).toBe(false);
    expect(ctx.send).not.toHaveBeenCalled();
  });
});
