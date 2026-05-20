import { saveConfig } from './config.js';

export function stripThreadId(conversationId) {
  return conversationId.split(';')[0];
}

export function createAccessControl(getConfigFn, getCredentialsFn) {
  function bindOwner(aadObjectId, name) {
    const config = getConfigFn();
    const previousOwner = config.owner;
    config.owner = {
      bound: true,
      aadObjectId,
      name: name || 'unknown'
    };
    if (!saveConfig(config)) {
      config.owner = previousOwner;
      console.error('[ms-teams] Failed to persist owner binding');
      return null;
    }
    console.log(`[ms-teams] Owner bound: ${name} (${aadObjectId})`);
    return name;
  }

  function isOwner(aadObjectId) {
    const config = getConfigFn();
    if (!config.owner?.bound) return false;
    return String(config.owner.aadObjectId) === String(aadObjectId);
  }

  function isDmAllowed(aadObjectId) {
    if (isOwner(aadObjectId)) return true;
    const config = getConfigFn();
    const policy = config.dmPolicy || 'owner';
    if (policy === 'open') return true;
    if (policy === 'owner') return false;
    const allowFrom = (config.dmAllowFrom || []).map(String);
    return allowFrom.includes(String(aadObjectId));
  }

  function isConversationAllowed(convType, conversationId) {
    const config = getConfigFn();
    const groupPolicy = config.groupPolicy || 'allowlist';
    if (groupPolicy === 'disabled') return false;
    if (groupPolicy === 'open') return true;
    const baseId = stripThreadId(conversationId);
    if (convType === 'channel') {
      const channels = config.channels || {};
      return !!channels[conversationId] || !!channels[baseId];
    }
    const groups = config.groups || {};
    return !!groups[conversationId] || !!groups[baseId];
  }

  function getConversationName(convType, conversationId) {
    const config = getConfigFn();
    const baseId = stripThreadId(conversationId);
    if (convType === 'channel') {
      const channels = config.channels || {};
      return channels[conversationId]?.name || channels[baseId]?.name || conversationId;
    }
    const groups = config.groups || {};
    return groups[conversationId]?.name || groups[baseId]?.name || conversationId;
  }

  return { bindOwner, isOwner, isDmAllowed, isConversationAllowed, getConversationName };
}

export function createMentionHelpers(getBotIdFn) {
  function isBotMention(entity) {
    if (entity.type !== 'mention') return false;
    const mentionedId = String(entity.mentioned?.id || '');
    if (!mentionedId) return false;
    const botId = getBotIdFn();
    return mentionedId === botId || mentionedId.endsWith(`:${botId}`);
  }

  function isBotMentioned(activity) {
    if (!activity.entities) return false;
    return activity.entities.some(isBotMention);
  }

  function stripBotMention(activity) {
    let text = activity.text || '';
    if (!activity.entities) return text;
    for (const entity of activity.entities) {
      if (isBotMention(entity) && entity.text) {
        text = text.replace(entity.text, '').trim();
      }
    }
    return text;
  }

  function replaceBotMention(activity, botName) {
    let text = activity.text || '';
    if (!activity.entities) return text;
    for (const entity of activity.entities) {
      if (isBotMention(entity) && entity.text) {
        const displayName = entity.mentioned?.name || botName;
        text = text.replace(entity.text, displayName).trim();
      }
    }
    return text;
  }

  return { isBotMention, isBotMentioned, stripBotMention, replaceBotMention };
}
