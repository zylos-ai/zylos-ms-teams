export function escapeXml(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

export function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function extractChannelIds(channelData) {
  const cd = channelData || {};
  return {
    teamId: cd.team?.aadGroupId || cd.team?.id || cd.teamId || '',
    channelId: cd.teamsChannelId || cd.channel?.id || cd.channelId || '',
  };
}

export function buildEndpoint(conversationId, { type, aadObjectId, activityId } = {}) {
  let endpoint = conversationId;
  if (type) endpoint += `|type:${type}`;
  if (aadObjectId) endpoint += `|user:${aadObjectId}`;
  if (activityId) endpoint += `|msg:${activityId}`;
  return endpoint;
}

/**
 * Conversation id of a channel post (one post thread = one session group and
 * one history): the post's root message id, or its own id for a top-level
 * post — the same `<channel>;messageid=<root>` Bot Framework reports.
 */
export function channelPostConversationId(channelId, messageId, rootMessageId) {
  return `${channelId};messageid=${rootMessageId || messageId}`;
}

/**
 * Conversation reference to store for an activity, always carrying the
 * conversationType Teams reported (the outbound policy's source of truth for
 * DM vs group/channel).
 */
export function referenceWithConversationType(convRef, activity) {
  const conversationType = activity?.conversation?.conversationType;
  if (!conversationType || convRef?.conversation?.conversationType === conversationType) return convRef;
  return { ...convRef, conversation: { ...(convRef?.conversation || activity.conversation), conversationType } };
}

export function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

export function getConversationType(activity) {
  const conversationType = activity.conversation?.conversationType;
  if (conversationType === 'personal') return 'dm';
  if (conversationType === 'groupChat') return 'group';
  if (conversationType === 'channel') return 'channel';
  return 'dm';
}

export function formatMessage(type, userName, text, { groupName, quotedReply, contextBlock, smartHint } = {}) {
  const prefix = type === 'dm'
    ? '[Teams DM]'
    : type === 'channel'
      ? `[Teams CHANNEL:${escapeXml(groupName || 'unknown')}]`
      : `[Teams GROUP:${escapeXml(groupName || 'unknown')}]`;
  const safeUserName = escapeXml(userName);
  const safeText = escapeXml(text);

  let content = `${prefix} ${safeUserName} said: `;
  if (contextBlock) content += contextBlock;
  content += `<current-message>\n${safeText}\n</current-message>`;

  if (quotedReply) {
    const safeQuotedFrom = escapeXml(quotedReply.quotedFrom);
    const safeQuotedText = escapeXml(quotedReply.quotedText);
    content += `\n<quoted-reply from="${safeQuotedFrom}">${safeQuotedText}</quoted-reply>`;
  }

  if (smartHint) {
    content += '\n<smart-mode>\nDecide whether to respond. Do NOT reply if: the message is unrelated to you, just casual chat, or doesn\'t need your input. Only reply when: 1) someone asks a question you can help with, 2) discussing technical topics you know well, 3) someone clearly needs assistance. When uncertain, prefer NOT to reply. Reply with exactly [SKIP] to stay silent.\n</smart-mode>';
  }

  return content;
}
