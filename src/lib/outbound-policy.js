/**
 * Outbound destination policy for scripts/send.js: a send must reach someone
 * the inbound rules would accept, and otherwise fails closed.
 *
 * The conversation type is taken from the stored conversation reference
 * (`conversation.conversationType` captured from Teams on inbound:
 * personal -> dm, groupChat -> group, channel -> channel), never from the
 * agent-written endpoint `type:`. A declared type that does not match the real
 * one, a missing reference, or an unknown real type is denied.
 *
 * - DM: the recipient is the user stored with the personal-chat reference (a
 *   personal chat has exactly one human member) and must pass inbound
 *   `isDmAllowed` (owner first; `dmPolicy: disabled` denies all).
 * - Group chat / channel: allowed when inbound `isConversationAllowed` allows
 *   it. Otherwise, in a channel only, a threaded reply to an accepted message
 *   the owner sent there (proven by an `accepted: true` record in the
 *   component's inbound log). The result then carries `replyOnly`: every chunk
 *   must be sent as a reply to that message, with no plain-send fallback, and
 *   media is refused. Group chats have no reply threading in Teams, so there
 *   is no owner-reply exception for them. `groupPolicy: disabled` denies
 *   everything, as inbound does.
 * - Any other type (e.g. `admin|type:dm-pairing`) is denied.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createAccessControl } from './access.js';
import { LOGS_DIR, chatIdToLogFile } from './context.js';

const TEAMS_TYPE = { personal: 'dm', groupChat: 'group', channel: 'channel' };

/**
 * The real conversation type of a stored reference, or null when unknown.
 * @param {object|null} ref
 * @returns {'dm'|'group'|'channel'|null}
 */
export function realConversationType(ref) {
  const t = ref?.conversation?.conversationType;
  return Object.hasOwn(TEAMS_TYPE, t ?? '') ? TEAMS_TYPE[t] : null;
}

/**
 * Find an accepted message in the component's inbound log for a conversation.
 * Only records marked `accepted: true` (written after access checks) count;
 * Graph history and other records are never proof. Missing or unreadable logs
 * mean "not proven", never "allowed".
 */
export function findLoggedMessage(conversationId, messageId, logsDir = LOGS_DIR) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(logsDir, chatIdToLogFile(conversationId)), 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.accepted === true && String(entry.message_id) === String(messageId)) return entry;
    } catch { /* malformed line is not proof */ }
  }
  return null;
}

/**
 * @param {object} config
 * @param {{conversationId: string, type?: string, msg?: string}} ep
 * @param {object} deps
 * @param {object|null} deps.ref - stored conversation reference for the endpoint
 * @param {(conversationId: string, messageId: string) => object|null} deps.findMessage
 * @returns {{reason: string|null, replyOnly?: boolean}} reason null when allowed
 */
export function outboundDecision(config, ep, { ref, findMessage }) {
  const deny = (reason) => ({ reason });
  const access = createAccessControl(() => config, () => ({}));
  const conversationId = ep?.conversationId;
  if (!conversationId) return deny('missing conversation id');
  const declared = ep.type || 'dm';
  if (declared !== 'dm' && declared !== 'group' && declared !== 'channel') {
    return deny(`unsupported destination type ${declared}`);
  }
  if (!ref) return deny('no stored conversation for this destination');
  const real = realConversationType(ref);
  if (!real) return deny('conversation type unknown (no conversationType stored)');
  if (real !== declared) return deny(`endpoint type ${declared} does not match conversation type ${real}`);

  if (real === 'dm') {
    const recipient = ref.user;
    if (!recipient?.aadObjectId) return deny('cannot verify DM recipient');
    if (!access.isDmAllowed(recipient.aadObjectId, recipient.name || '')) {
      return deny(`DM recipient ${recipient.aadObjectId} is not allowed by dmPolicy=${config.dmPolicy || 'owner'}`);
    }
    return { reason: null };
  }

  if (access.isConversationAllowed(real, conversationId)) return { reason: null };
  const policy = config.groupPolicy || 'allowlist';
  if (policy !== 'disabled' && real === 'channel' && ep.msg) {
    const entry = findMessage(conversationId, ep.msg);
    if (entry && access.isOwner(entry.user_id)) return { reason: null, replyOnly: true };
  }
  return deny(`${real} ${conversationId} is not allowed (groupPolicy=${policy}) and the message is not a channel reply to an accepted owner message`);
}

/** Back-compat wrapper: denial reason or null. */
export function outboundDenialReason(config, ep, deps) {
  return outboundDecision(config, ep, deps).reason;
}
