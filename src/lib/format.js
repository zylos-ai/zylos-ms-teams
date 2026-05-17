export function escapeXml(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

export function buildEndpoint(conversationId, { type, aadObjectId, activityId } = {}) {
  let endpoint = conversationId;
  if (type) endpoint += `|type:${type}`;
  if (aadObjectId) endpoint += `|user:${aadObjectId}`;
  if (activityId) endpoint += `|msg:${activityId}`;
  return endpoint;
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
