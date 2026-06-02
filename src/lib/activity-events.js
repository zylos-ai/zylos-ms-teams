export function activityDedupKey(activity, kind) {
  return [
    activity?.id || activity?.replyToId || activity?.conversation?.id || 'unknown',
    kind,
    activity?.timestamp || activity?.localTimestamp || activity?.channelData?.eventTime || '',
  ].join(':');
}

export function editedMessageText(text) {
  return `[edited] ${String(text || '').trim()}`.trim();
}

export function deletedMessageText(senderName) {
  return `[message deleted by ${senderName || 'unknown'}]`;
}

export function extractCardActionPayload(activity) {
  return activity?.value?.action?.data || activity?.value?.data || activity?.value || {};
}

export function cardActionMessage(senderName, payload) {
  return `[Card Action from ${senderName || 'unknown'}] ${JSON.stringify(payload || {})}`;
}
