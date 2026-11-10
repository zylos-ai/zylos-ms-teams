/**
 * Outbound destination policy for scripts/send.js: a send must reach someone
 * the inbound rules would accept, and otherwise fails closed.
 *
 * - DM (`type:dm`): the recipient is the user stored with the conversation
 *   reference (not the endpoint's `user:` part, which the agent can edit) and
 *   must pass inbound `isDmAllowed` (owner first; `dmPolicy: disabled` denies all).
 * - Group chat / channel: allowed when inbound `isConversationAllowed` allows
 *   it. Otherwise only a reply to an accepted message the owner sent there,
 *   proven by the component's own inbound log (`logs/<chat>.jsonl`, written only
 *   after the message passed access checks). `groupPolicy: disabled` denies
 *   everything, as inbound does.
 * - Any other type (e.g. `admin|type:dm-pairing`) is denied.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createAccessControl } from './access.js';
import { LOGS_DIR, chatIdToLogFile } from './context.js';

/**
 * Find a message in the component's inbound log for a conversation.
 * Missing or unreadable logs mean "not proven", never "allowed".
 */
export function findLoggedMessage(conversationId, messageId, logsDir = LOGS_DIR) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(logsDir, chatIdToLogFile(conversationId)), 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (String(entry?.message_id) === String(messageId)) return entry;
    } catch { /* malformed line is not proof */ }
  }
  return null;
}

/**
 * @param {object} config
 * @param {{conversationId: string, type?: string, msg?: string}} ep
 * @param {object} deps
 * @param {(conversationId: string) => object|null} deps.getRecipient - stored
 *   DM partner `{ aadObjectId, name }`, or null
 * @param {(conversationId: string, messageId: string) => object|null} deps.findMessage
 * @returns {string|null} denial reason, or null when allowed
 */
export function outboundDenialReason(config, ep, { getRecipient, findMessage }) {
  const access = createAccessControl(() => config, () => ({}));
  const conversationId = ep?.conversationId;
  if (!conversationId) return 'missing conversation id';
  const type = ep.type || 'dm';

  if (type === 'dm') {
    const recipient = getRecipient(conversationId);
    if (!recipient?.aadObjectId) return 'cannot verify DM recipient (no stored conversation)';
    if (!access.isDmAllowed(recipient.aadObjectId, recipient.name || '')) {
      return `DM recipient ${recipient.aadObjectId} is not allowed by dmPolicy=${config.dmPolicy || 'owner'}`;
    }
    return null;
  }

  if (type !== 'group' && type !== 'channel') return `unsupported destination type ${type}`;
  if (access.isConversationAllowed(type, conversationId)) return null;
  const policy = config.groupPolicy || 'allowlist';
  if (policy !== 'disabled' && ep.msg) {
    const entry = findMessage(conversationId, ep.msg);
    if (entry && access.isOwner(entry.user_id)) return null;
  }
  return `${type} ${conversationId} is not allowed (groupPolicy=${policy}) and the message is not a reply to an accepted owner message`;
}
