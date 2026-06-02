export const UNSUPPORTED_CONTENT_REPLY = "I received your message but couldn't process this type of content yet.";

export function hasProcessableInboundContent(text, mediaFiles = []) {
  return Boolean((text || '').trim()) || mediaFiles.length > 0;
}

export function describeUnsupportedAttachment(attachment = {}) {
  const contentType = String(attachment.contentType || '').toLowerCase();
  if (!contentType) return null;
  if (contentType === 'image/gif') return 'GIF animation';
  if (contentType === 'application/vnd.microsoft.teams.sticker') return 'sticker';
  if (contentType.startsWith('audio/')) return 'audio message';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('application/vnd.microsoft.card.')) return 'interactive card';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.includes('file.download.info')) return 'file';
  return null;
}

export function buildUnsupportedContentReply(attachments = []) {
  for (const attachment of attachments || []) {
    const description = describeUnsupportedAttachment(attachment);
    if (description) {
      return `I received a ${description}, but couldn't process that content yet.`;
    }
  }
  return UNSUPPORTED_CONTENT_REPLY;
}

export async function replyIfUnsupportedInboundContent(ctx, text, mediaFiles = [], {
  addressed = true,
  attachments = [],
} = {}) {
  if (!addressed) return false;
  if (hasProcessableInboundContent(text, mediaFiles)) return false;
  await ctx.send(buildUnsupportedContentReply(attachments)).catch(() => {});
  return true;
}
