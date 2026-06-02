import { describe, it, expect, vi } from 'vitest';
import {
  UNSUPPORTED_CONTENT_REPLY,
  replyIfUnsupportedInboundContent,
} from '../src/lib/inbound-content.js';

describe('unsupported inbound content handling', () => {
  it('sends an unsupported-content reply when text and media are both empty', async () => {
    const ctx = { send: vi.fn().mockResolvedValue(undefined) };

    const handled = await replyIfUnsupportedInboundContent(ctx, '   ', []);

    expect(handled).toBe(true);
    expect(ctx.send).toHaveBeenCalledWith(UNSUPPORTED_CONTENT_REPLY);
  });

  it('does not send an unsupported-content reply when text is present', async () => {
    const ctx = { send: vi.fn().mockResolvedValue(undefined) };

    const handled = await replyIfUnsupportedInboundContent(ctx, 'hello', []);

    expect(handled).toBe(false);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('does not send an unsupported-content reply when media is present', async () => {
    const ctx = { send: vi.fn().mockResolvedValue(undefined) };

    const handled = await replyIfUnsupportedInboundContent(ctx, '', [{ path: '/tmp/file.png' }]);

    expect(handled).toBe(false);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('does not send an unsupported-content reply for unaddressed smart-mode observations', async () => {
    const ctx = { send: vi.fn().mockResolvedValue(undefined) };

    const handled = await replyIfUnsupportedInboundContent(ctx, '', [], { addressed: false });

    expect(handled).toBe(false);
    expect(ctx.send).not.toHaveBeenCalled();
  });
});
