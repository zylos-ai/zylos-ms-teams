import { describe, it, expect, vi } from 'vitest';
import {
  UNSUPPORTED_CONTENT_REPLY,
  buildUnsupportedContentReply,
  describeUnsupportedAttachment,
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

  it('describes known unsupported attachment types', () => {
    expect(describeUnsupportedAttachment({ contentType: 'image/gif' })).toBe('GIF animation');
    expect(describeUnsupportedAttachment({ contentType: 'application/vnd.microsoft.teams.sticker' })).toBe('sticker');
    expect(describeUnsupportedAttachment({ contentType: 'audio/ogg' })).toBe('audio message');
    expect(describeUnsupportedAttachment({ contentType: 'video/mp4' })).toBe('video');
    expect(describeUnsupportedAttachment({ contentType: 'application/vnd.microsoft.card.adaptive' })).toBe('interactive card');
    expect(describeUnsupportedAttachment({ contentType: 'application/vnd.microsoft.teams.file.download.info' })).toBe('file');
  });

  it('builds a descriptive unsupported-content reply from attachments', async () => {
    const ctx = { send: vi.fn().mockResolvedValue(undefined) };
    const attachments = [{ contentType: 'video/mp4' }];

    expect(buildUnsupportedContentReply(attachments)).toBe("I received a video, but couldn't process that content yet.");

    const handled = await replyIfUnsupportedInboundContent(ctx, '', [], { attachments });

    expect(handled).toBe(true);
    expect(ctx.send).toHaveBeenCalledWith("I received a video, but couldn't process that content yet.");
  });
});
