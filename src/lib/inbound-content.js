export const UNSUPPORTED_CONTENT_REPLY = "I received your message but couldn't process this type of content yet.";

export function hasProcessableInboundContent(text, mediaFiles = []) {
  return Boolean((text || '').trim()) || mediaFiles.length > 0;
}

export async function replyIfUnsupportedInboundContent(ctx, text, mediaFiles = [], { addressed = true } = {}) {
  if (!addressed) return false;
  if (hasProcessableInboundContent(text, mediaFiles)) return false;
  await ctx.send(UNSUPPORTED_CONTENT_REPLY).catch(() => {});
  return true;
}
