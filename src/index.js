#!/usr/bin/env node
/**
 * zylos-ms-teams - Microsoft Teams Bot Service
 *
 * Uses @microsoft/teams.apps v2 SDK for receiving/sending Teams messages
 * and routes inbound messages to Claude via C4 Communication Bridge.
 */

import dotenv from 'dotenv';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { App, ExpressAdapter } from '@microsoft/teams.apps';

import { getConfig, watchConfig, saveConfig, stopWatching, DATA_DIR, getCredentials, getPublicUrl, resolveRouteConfig, isSmartConversation } from './lib/config.js';
import { createMessageDeduper, MESSAGE_DEDUP_TTL_MS } from './lib/message-dedup.js';
import { saveConversationReference, getConversationReference, getAllConversationReferences } from './lib/conversation-store.js';
import { htmlToText, extractQuotedReply, extractReplyBlockquote } from './lib/html.js';
import { createJwtMiddleware } from './lib/auth.js';
import { isGraphEnabled, acquireTokenForScope, fetchChatHistory, fetchChannelHistory } from './lib/graph.js';
import { resolveInboundMedia } from './lib/attachments.js';
import { escapeXml, buildEndpoint, parseC4Response, getConversationType, formatMessage, extractChannelIds } from './lib/format.js';
import { getDelegatedToken, hasAuth, sendReaction, getAuthenticatedUsers } from './lib/delegated-auth.js';
import { syncSubscriptions, startRenewalLoop, stopRenewalLoop, fetchMessage, fetchReplyMessage, getClientState } from './lib/channel-subscriptions.js';
import { writeJsonAtomic } from './lib/atomic-write.js';
import { createAccessControl, createMentionHelpers, stripThreadId } from './lib/access.js';
import { recordHistoryEntry, getInMemoryContext, formatContextBlock, ensureReplay } from './lib/history.js';
import { registerRoutes } from './routes.js';

const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex');
const REACTION_CACHE_FILE = path.join(DATA_DIR, 'reaction-cache.json');
const reactionContextCache = new Map();
const pendingReactions = new Map();
const typingIntervals = new Map();

// Load persisted reaction context on startup
try {
  const cached = JSON.parse(fs.readFileSync(REACTION_CACHE_FILE, 'utf8'));
  for (const [k, v] of Object.entries(cached)) reactionContextCache.set(k, v);
} catch {}

function persistReactionCache() {
  try {
    writeJsonAtomic(REACTION_CACHE_FILE, Object.fromEntries(reactionContextCache));
  } catch {}
}

const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_TOKEN, { mode: 0o600 });
} catch (err) {
  console.error(`[ms-teams] Failed to write internal token file: ${err.message}`);
}

console.log('[ms-teams] Starting...');
console.log(`[ms-teams] Data directory: ${DATA_DIR}`);

const TRANSCRIBE_SCRIPT = path.join(process.env.HOME, 'zylos/bin/transcribe');
let VOICE_ENABLED = false;
try {
  execFileSync(TRANSCRIBE_SCRIPT, ['--check'], { timeout: 5000 });
  VOICE_ENABLED = true;
} catch {}
console.log(`[ms-teams] Voice ASR: ${VOICE_ENABLED ? 'enabled' : 'disabled (whisper or transcribe.py not found)'}`);

function transcribeAudio(audioPath) {
  return new Promise((resolve, reject) => {
    execFile(TRANSCRIBE_SCRIPT, [audioPath], { timeout: 90000, encoding: 'utf8' }, (err, stdout) => {
      if (err) return reject(err);
      resolve((stdout || '').trim());
    });
  });
}

// Message deduplication
const messageDeduper = createMessageDeduper({
  ttlMs: MESSAGE_DEDUP_TTL_MS,
  logDuplicate: (messageId) => {
    console.log(`[ms-teams] Duplicate activity ${messageId}, skipping`);
  }
});

function isDuplicate(activityId) {
  return messageDeduper.checkAndMark(activityId);
}

const dedupCleanupInterval = setInterval(() => {
  messageDeduper.sweepExpired();
}, MESSAGE_DEDUP_TTL_MS);

// Load configuration
let config = getConfig();
console.log(`[ms-teams] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log('[ms-teams] Component disabled in config, exiting.');
  process.exit(0);
}

// Credentials check
const credentials = getCredentials();
if (!credentials.appId || !credentials.appPassword) {
  console.error('[ms-teams] WARNING: MSTEAMS_APP_ID and/or MSTEAMS_APP_PASSWORD not set in ~/zylos/.env');
  console.error('[ms-teams] The bot will start but cannot authenticate with Teams.');
  console.error('[ms-teams] Set credentials and restart: pm2 restart zylos-ms-teams');
}

// Bot identity
let botName = 'bot';
let botId = credentials.appId || '';

// Initialize access control and mention helpers
const access = createAccessControl(() => config, () => credentials);
const mentions = createMentionHelpers(() => botId);

// Config watcher
watchConfig(async (newConfig) => {
  console.log('[ms-teams] Config reloaded');
  config = newConfig;
  if (!newConfig.enabled) {
    console.log('[ms-teams] Component disabled, stopping...');
    shutdown();
    return;
  }
  try {
    await initChannelSubscriptions();
  } catch (err) {
    console.warn(`[ms-teams/subs] Re-sync on config reload failed: ${err.message}`);
  }
});

// Wrapper to pass config to recordHistoryEntry
function recordHistory(chatId, entry) {
  recordHistoryEntry(chatId, entry, config);
}

// ── Express + HTTP Server ──

const expressApp = express();

if (credentials.appId) {
  const jwtMiddleware = createJwtMiddleware({
    appId: credentials.appId,
    tenantId: credentials.tenantId || undefined,
  });
  expressApp.post('/api/messages', jwtMiddleware);
}

const httpServer = http.createServer(expressApp);

// ── Teams App SDK ──

const adapter = new ExpressAdapter(expressApp);

const teamsApp = new App({
  clientId: credentials.appId || undefined,
  clientSecret: credentials.appPassword || undefined,
  tenantId: credentials.tenantId || undefined,
  httpServerAdapter: adapter,
  activity: {
    mentions: {
      stripText: false,
    },
  },
});

// Register HTTP routes
registerRoutes(expressApp, {
  internalToken: INTERNAL_TOKEN,
  teamsApp,
  botName,
  reactionContextCache,
  pendingReactions,
  persistReactionCache,
  recordHistoryEntry: recordHistory,
  handleChannelNotification,
  stopTyping,
});

// ── Typing Indicators ──

function startTyping(conversationId) {
  stopTyping(conversationId);
  const baseId = conversationId.split(';')[0];
  const send = async () => {
    try {
      const ref = await getConversationReference(baseId);
      if (!ref?.serviceUrl) return;
      const token = await acquireTokenForScope('https://api.botframework.com/.default');
      const serviceUrl = ref.serviceUrl.replace(/\/$/, '');
      const url = `${serviceUrl}/v3/conversations/${encodeURIComponent(baseId)}/activities`;
      await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'typing', conversation: { id: baseId } }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {}
  };
  send();
  const interval = setInterval(send, 3000);
  typingIntervals.set(conversationId, interval);
}

function stopTyping(conversationId) {
  const interval = typingIntervals.get(conversationId);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(conversationId);
  }
}

// ── C4 Communication ──

function sendToC4(source, endpoint, content, onReject) {
  if (!content) {
    console.error('[ms-teams] sendToC4 called with empty content');
    return;
  }
  const args = [
    C4_RECEIVE,
    '--channel', source,
    '--endpoint', endpoint,
    '--json',
    '--content', content
  ];

  execFile('node', args, { encoding: 'utf8', timeout: 35000 }, (error, stdout) => {
    if (!error) {
      console.log(`[ms-teams] Sent to C4: ${content.substring(0, 50)}...`);
      return;
    }
    const response = parseC4Response(error.stdout || stdout);
    if (response && response.ok === false && response.error?.message) {
      console.warn(`[ms-teams] C4 rejected (${response.error.code}): ${response.error.message}`);
      if (onReject) onReject(response.error.message);
      return;
    }
    console.warn(`[ms-teams] C4 send failed, retrying in 2s: ${error.message}`);
    setTimeout(() => {
      execFile('node', args, { encoding: 'utf8', timeout: 35000 }, (retryError, retryStdout) => {
        if (!retryError) {
          console.log(`[ms-teams] Sent to C4 (retry): ${content.substring(0, 50)}...`);
          return;
        }
        const retryResponse = parseC4Response(retryError.stdout || retryStdout);
        if (retryResponse && retryResponse.ok === false && retryResponse.error?.message) {
          console.error(`[ms-teams] C4 rejected after retry (${retryResponse.error.code}): ${retryResponse.error.message}`);
          if (onReject) onReject(retryResponse.error.message);
        } else {
          console.error(`[ms-teams] C4 send failed after retry: ${retryError.message}`);
        }
      });
    }, 2000);
  });
}

function extractMessageContent(activity) {
  const htmlAtt = activity.attachments?.find(
    a => a.contentType === 'text/html' && a.content
  );
  if (htmlAtt) {
    const { html } = extractReplyBlockquote(htmlAtt.content);
    return html;
  }
  return activity.text || '';
}

async function saveConvRef(activity, ref) {
  const conversationId = activity.conversation?.id;
  if (!conversationId) return;

  const tenantId = activity.channelData?.tenant?.id
    || activity.conversation?.tenantId
    || credentials.tenantId
    || '';

  const convRef = ref || {
    activityId: activity.id,
    bot: activity.recipient,
    channelId: activity.channelId || 'msteams',
    conversation: activity.conversation,
    serviceUrl: activity.serviceUrl,
    user: activity.from,
  };

  await saveConversationReference(conversationId, convRef, { tenantId });
}

// ── Message Handler ──

async function handleMessage(ctx) {
  const activity = ctx.activity;
  if (!activity) return;

  const activityId = activity.id;
  if (isDuplicate(activityId)) return;

  await saveConvRef(activity, ctx.ref);

  const senderAadObjectId = activity.from?.aadObjectId || '';
  const senderName = activity.from?.name || 'unknown';
  const conversationId = activity.conversation?.id || '';
  const convType = getConversationType(activity);

  const rawText = extractMessageContent(activity);
  const text = htmlToText(rawText);
  let quotedReply = extractQuotedReply(activity);

  console.log(`[ms-teams] ${convType} message from ${senderName} (${senderAadObjectId})`);

  const historyText = htmlToText(mentions.stripBotMention(activity));
  function recordAccepted() {
    console.log(`[ms-teams] Accepted: ${convType} from ${senderName}: ${text.substring(0, 50)}...`);
    recordHistory(conversationId, {
      timestamp: activity.timestamp || new Date().toISOString(),
      message_id: activityId,
      user_id: senderAadObjectId,
      user_name: senderName,
      text: historyText,
    });
  }

  function logRejection(reason) {
    console.log(`[ms-teams] Rejected: sender=${senderAadObjectId}, name=${senderName}, conv=${conversationId}, reason=${reason}`);
  }

  async function downloadMedia() {
    let dlgToken;
    if (convType === 'channel') {
      const authUser = hasAuth(senderAadObjectId) ? senderAadObjectId : getAuthenticatedUsers()[0]?.aadObjectId;
      if (authUser) try { dlgToken = await getDelegatedToken(authUser); } catch {}
    }
    return resolveInboundMedia({
      attachments: activity.attachments,
      conversationType: convType,
      conversationId,
      serviceUrl: activity.serviceUrl,
      activity,
      delegatedToken: dlgToken || undefined,
    });
  }

  const endpoint = buildEndpoint(conversationId, {
    type: convType,
    aadObjectId: senderAadObjectId,
    activityId
  });

  const rejectReply = async (errMsg) => {
    try {
      await ctx.send(errMsg);
    } catch (err) {
      console.error(`[ms-teams] Failed to send reject reply: ${err.message}`);
    }
  };

  if (convType === 'dm') {
    if (!config.owner?.bound) {
      await access.bindOwner(senderAadObjectId, senderName);
    }

    if (!access.isDmAllowed(senderAadObjectId)) {
      logRejection(`dmPolicy=${config.dmPolicy || 'owner'}`);
      await ctx.send("Sorry, I'm not available for private messages. Please ask my owner to grant you access.");
      return;
    }

    recordAccepted();

    {
      const reactUser = hasAuth(senderAadObjectId) ? senderAadObjectId : getAuthenticatedUsers()[0]?.aadObjectId;
      if (reactUser) {
        if (!pendingReactions.has(conversationId)) pendingReactions.set(conversationId, []);
        pendingReactions.get(conversationId).push({ messageId: activityId, conversationType: convType, activity });
        sendReaction({
          aadObjectId: reactUser,
          conversationType: convType,
          conversationId,
          messageId: activityId,
          reactionType: '💬',
          activity,
        }).catch(err => console.debug(`[ms-teams] Auto-react skipped: ${err.message}`));
      }
    }

    const mediaFiles = await downloadMedia();

    const audioFile = mediaFiles.find(m => {
      const ct = (m.contentType || '').toLowerCase();
      return ct.startsWith('audio/') || ct.startsWith('video/');
    });
    if (audioFile && VOICE_ENABLED) {
      try {
        const transcript = await transcribeAudio(audioFile.path);
        console.log(`[ms-teams] Voice transcribed: "${transcript.substring(0, 60)}"`);
        const msg = formatMessage('dm', senderName, `[Voice] ${transcript}`, { quotedReply });
        startTyping(conversationId);
        sendToC4('ms-teams', endpoint, msg, (errMsg) => rejectReply(errMsg));
        fs.unlink(audioFile.path, () => {});
        return;
      } catch (err) {
        console.error(`[ms-teams] Voice transcription error: ${err.message}`);
      }
    }

    let msg = formatMessage('dm', senderName, text, { quotedReply });
    for (const media of mediaFiles) msg += ` ---- file: ${escapeXml(media.path)}`;
    startTyping(conversationId);
    sendToC4('ms-teams', endpoint, msg, (errMsg) => rejectReply(errMsg));
    return;
  }

  // Group / channel handling
  if (convType === 'group' || convType === 'channel') {
    const senderIsOwner = access.isOwner(senderAadObjectId);
    const groupPolicy = config.groupPolicy || 'allowlist';
    const mentioned = mentions.isBotMentioned(activity);
    const routeConfig = resolveRouteConfig(convType, conversationId, config);
    const smart = isSmartConversation(config, convType, conversationId);
    const smartNoMention = smart && !mentioned;

    if (groupPolicy === 'disabled') {
      logRejection('groupPolicy=disabled');
      return;
    }

    const allowedGroup = access.isConversationAllowed(convType, conversationId);

    if (routeConfig.allowFrom.length > 0 && !senderIsOwner) {
      if (!routeConfig.allowFrom.includes(senderAadObjectId)) {
        if (mentioned) {
          logRejection('not in allowFrom');
          await ctx.send("Sorry, you don't have access in this channel.");
        }
        return;
      }
    }

    if (!allowedGroup && !senderIsOwner) {
      if (mentioned) {
        logRejection('group not allowed');
        await ctx.send("Sorry, I'm not available in this group.");
      }
      return;
    }

    const requireMention = routeConfig.requireMention;

    if (requireMention && !mentioned && !senderIsOwner && !smart) {
      return;
    }

    if (!mentioned && senderIsOwner && !allowedGroup) {
      // Owner in non-allowed group without mention: process as owner override
    }

    recordAccepted();

    if (!smartNoMention) {
      const reactUser = hasAuth(senderAadObjectId) ? senderAadObjectId : getAuthenticatedUsers()[0]?.aadObjectId;
      if (reactUser) {
        if (convType === 'channel') {
          reactionContextCache.set(activityId, extractChannelIds(activity?.channelData));
          persistReactionCache();
          setTimeout(() => { reactionContextCache.delete(activityId); persistReactionCache(); }, 10 * 60_000);
        }
        if (!pendingReactions.has(conversationId)) pendingReactions.set(conversationId, []);
        pendingReactions.get(conversationId).push({ messageId: activityId, conversationType: convType, activity });
        sendReaction({
          aadObjectId: reactUser,
          conversationType: convType,
          conversationId,
          messageId: activityId,
          reactionType: '💬',
          activity,
        }).catch(err => console.debug(`[ms-teams] Auto-react skipped: ${err.message}`));
      }
    }

    const groupRaw = extractMessageContent(activity);
    const groupActivity = { ...activity, text: groupRaw };
    let cleanText = htmlToText(mentions.replaceBotMention(groupActivity, botName));
    const botMentionEntity = activity.entities?.find(e => mentions.isBotMention(e));
    if (botMentionEntity?.mentioned?.name && cleanText.startsWith(botMentionEntity.mentioned.name)) {
      cleanText = cleanText.slice(botMentionEntity.mentioned.name.length).trim();
    }
    const groupName = access.getConversationName(convType, conversationId);

    if (!quotedReply && convType === 'channel' && isGraphEnabled()) {
      const threadRootId = activity.replyToId || conversationId.match(/;messageid=(\d+)/)?.[1];
      if (threadRootId) {
        try {
          const { teamId, channelId } = extractChannelIds(activity.channelData);
          if (teamId && channelId) {
            const parentMsg = await fetchMessage(teamId, channelId, threadRootId);
            const parentName = parentMsg.from?.user?.displayName || parentMsg.from?.application?.displayName || 'unknown';
            const parentText = parentMsg.body?.contentType === 'text'
              ? parentMsg.body?.content || ''
              : htmlToText(parentMsg.body?.content || '');
            if (parentText.trim()) {
              quotedReply = { quotedFrom: parentName, quotedText: parentText.substring(0, 500) };
            }
          }
        } catch (err) {
          console.debug(`[ms-teams] Thread parent fetch failed: ${err.message}`);
        }
      }
    }

    const convConfig = convType === 'channel'
      ? (config.channels?.[conversationId] || config.channels?.[stripThreadId(conversationId)])
      : (config.groups?.[conversationId] || config.groups?.[stripThreadId(conversationId)]);
    const contextLimit = convConfig?.historyLimit || config.message?.context_messages || 10;
    await ensureReplay(conversationId, recordHistory, contextLimit);
    let contextMessages = getInMemoryContext(conversationId, activityId, contextLimit);

    if (isGraphEnabled()) {
      try {
        const { teamId, channelId } = extractChannelIds(activity.channelData);
        const threadMatch = conversationId.match(/;messageid=(\d+)/);
        const threadMessageId = threadMatch ? threadMatch[1] : '';
        const authUser = hasAuth(senderAadObjectId) ? senderAadObjectId : getAuthenticatedUsers()[0]?.aadObjectId;
        const delegatedToken = authUser ? await getDelegatedToken(authUser) : '';
        const graphMessages = teamId
          ? await fetchChannelHistory(teamId, channelId, contextLimit, threadMessageId, delegatedToken || '')
          : await fetchChatHistory(conversationId, contextLimit);
        for (const gm of graphMessages) {
          recordHistory(conversationId, {
            timestamp: gm.time,
            message_id: gm.id || `graph-${gm.time}`,
            user_id: gm.from,
            user_name: gm.from,
            text: gm.body,
          });
        }
        contextMessages = getInMemoryContext(conversationId, activityId, contextLimit);
      } catch (err) {
        console.warn(`[ms-teams] Graph context fetch failed: ${err.message}`);
      }
    }

    const contextBlock = formatContextBlock(contextMessages);

    const allAtts = activity.attachments || [];
    if (allAtts.length > 0) {
      console.debug(`[ms-teams] Attachments (${allAtts.length}): ${JSON.stringify(allAtts.map(a => ({ contentType: a.contentType, name: a.name })))}`);
    }
    if (smartNoMention) {
      console.debug(`[ms-teams] Smart-no-mention: attachments=${allAtts.length}, hasText=${!!(activity.text || '').trim()}`);
    }
    const nonHtmlAtts = allAtts.filter(a => !(a.contentType || '').startsWith('text/html'));
    const hasVoiceAttachment = (() => {
      if (nonHtmlAtts.some(a => {
        const ct = (a.contentType || '').toLowerCase();
        return ct.startsWith('audio/') || ct.startsWith('video/');
      })) return true;
      const rawText = (activity.text || '').trim();
      if (/video.?clip/i.test(rawText)) return true;
      for (const att of allAtts) {
        if (!(att.contentType || '').startsWith('text/html')) continue;
        const html = typeof att.content === 'string' ? att.content : (att.content?.text || att.content?.body || '');
        if (/<attachment[^>]+id=/i.test(html)) return true;
        if (/schema\.skype\.com\/InputExtension/i.test(html)) return true;
      }
      return false;
    })();
    const shouldDownload = !smartNoMention || hasVoiceAttachment;
    const mediaFiles = shouldDownload ? await downloadMedia() : [];
    const hasAttachments = nonHtmlAtts.length > 0;

    if (hasVoiceAttachment && VOICE_ENABLED) {
      const audioFile = mediaFiles.find(m => {
        const ct = (m.contentType || '').toLowerCase();
        return ct.startsWith('audio/') || ct.startsWith('video/');
      });
      if (audioFile) {
        try {
          const transcript = await transcribeAudio(audioFile.path);
          console.log(`[ms-teams] Voice transcribed (group): "${transcript.substring(0, 60)}"`);
          cleanText = `[Voice] ${transcript}`;
          fs.unlink(audioFile.path, () => {});
        } catch (err) {
          console.error(`[ms-teams] Voice transcription error: ${err.message}`);
        }
      }
    }

    let msg = formatMessage(convType, senderName, cleanText, {
      groupName, quotedReply, contextBlock, smartHint: smartNoMention && !hasVoiceAttachment,
    });
    if (smartNoMention && !hasVoiceAttachment) {
      if (hasAttachments) {
        const attNames = nonHtmlAtts.map(a => a.name || a.contentType || 'file').join(', ');
        msg += ` [attachments: ${attNames}]`;
      }
      let dlCmd;
      if (convType === 'channel') {
        const { teamId: tid, channelId: chid } = extractChannelIds(activity.channelData);
        dlCmd = activity.replyToId
          ? `channel ${tid} ${chid} ${activityId} ${activity.replyToId}`
          : `channel ${tid} ${chid} ${activityId}`;
      } else {
        dlCmd = `chat ${conversationId} ${activityId}`;
      }
      msg += ` ---- download: node ~/zylos/.claude/skills/ms-teams/scripts/download-attachments.js ${dlCmd}`;
    }
    for (const media of mediaFiles) {
      if (media.contentType?.startsWith('audio/') || media.contentType?.startsWith('video/')) continue;
      msg += ` ---- file: ${escapeXml(media.path)}`;
    }
    if (!smartNoMention && convType !== 'channel') startTyping(conversationId);
    sendToC4('ms-teams', endpoint, msg, (errMsg) => rejectReply(errMsg));
    return;
  }
}

// ── Channel Notification Handler ──

async function handleChannelNotification(notification) {
  const resource = notification.resource || '';
  const teamMatch = resource.match(/teams\('([^']+)'\)/);
  const channelMatch = resource.match(/channels\('([^']+)'\)/);
  const msgMatch = resource.match(/messages\('([^']+)'\)/);
  const replyMatch = resource.match(/replies\('([^']+)'\)/);

  if (!teamMatch || !channelMatch) {
    console.debug(`[ms-teams/subs] Skipping notification with unrecognized resource: ${resource}`);
    return;
  }

  const teamId = teamMatch[1];
  const channelId = channelMatch[1];
  const messageId = replyMatch?.[1] || msgMatch?.[1];
  if (!messageId) return;

  const rootMessageId = replyMatch ? msgMatch?.[1] : null;

  let graphMsg;
  try {
    if (rootMessageId) {
      graphMsg = await fetchReplyMessage(teamId, channelId, rootMessageId, messageId);
    } else {
      graphMsg = await fetchMessage(teamId, channelId, messageId);
    }
  } catch (err) {
    console.warn(`[ms-teams/subs] Failed to fetch message ${messageId}: ${err.message}`);
    return;
  }

  if (graphMsg.from?.application?.id === credentials.appId) return;
  if (graphMsg.messageType && graphMsg.messageType !== 'message') return;
  if (!isSmartConversation(config, 'channel', channelId)) return;

  const senderName = graphMsg.from?.user?.displayName || 'unknown';
  const senderAadId = graphMsg.from?.user?.id || '';
  const text = graphMsg.body?.contentType === 'text'
    ? graphMsg.body.content || ''
    : htmlToText(graphMsg.body?.content || '');

  const graphAttachments = (graphMsg.attachments || []).filter(a =>
    a.contentType !== 'messageReference'
  );
  const hasAttachments = graphAttachments.length > 0;

  if (!text.trim() && !hasAttachments) return;
  if (isDuplicate(`graph-${messageId}`)) return;

  const mentionsList = graphMsg.mentions || [];
  const botMentioned = mentionsList.some(m =>
    m.mentioned?.application?.id === credentials.appId
  );
  if (botMentioned) return;

  const senderIsOwner = access.isOwner(senderAadId);
  const conversationId = channelId;

  if (!access.isConversationAllowed('channel', conversationId) && !senderIsOwner) return;

  const routeConfig = resolveRouteConfig('channel', conversationId, config);
  if (routeConfig.allowFrom.length > 0 && !senderIsOwner) {
    if (!routeConfig.allowFrom.includes(senderAadId)) return;
  }

  const threadConversationId = rootMessageId
    ? `${channelId};messageid=${rootMessageId}`
    : channelId;

  recordHistory(threadConversationId, {
    timestamp: graphMsg.createdDateTime || new Date().toISOString(),
    message_id: messageId,
    user_id: senderAadId,
    user_name: senderName,
    text,
  });

  const channelName = access.getConversationName('channel', conversationId);

  let quotedReply = null;
  if (rootMessageId) {
    try {
      const parentMsg = await fetchMessage(teamId, channelId, rootMessageId);
      const parentName = parentMsg.from?.user?.displayName || parentMsg.from?.application?.displayName || 'unknown';
      const parentText = parentMsg.body?.contentType === 'text'
        ? parentMsg.body?.content || ''
        : htmlToText(parentMsg.body?.content || '');
      if (parentText.trim()) {
        quotedReply = { quotedFrom: parentName, quotedText: parentText.substring(0, 500) };
      }
    } catch (err) {
      console.debug(`[ms-teams/subs] Thread parent fetch failed: ${err.message}`);
    }
  }

  const contextLimit = config.channels?.[conversationId]?.historyLimit
    || config.message?.context_messages || 10;
  await ensureReplay(threadConversationId, recordHistory, contextLimit);
  const contextMessages = getInMemoryContext(threadConversationId, messageId, contextLimit);
  const contextBlock = formatContextBlock(contextMessages);

  let msg = formatMessage('channel', senderName, text, {
    groupName: channelName,
    quotedReply,
    contextBlock,
    smartHint: true,
  });

  const endpoint = buildEndpoint(threadConversationId, {
    type: 'channel',
    aadObjectId: senderAadId,
    activityId: messageId,
  });

  if (hasAttachments) {
    const attNames = graphAttachments.map(a => a.name || a.contentType || 'file').join(', ');
    msg += ` [attachments: ${attNames}]`;
  }
  const dlArgs = rootMessageId
    ? `channel ${teamId} ${channelId} ${messageId} ${rootMessageId}`
    : `channel ${teamId} ${channelId} ${messageId}`;
  msg += ` ---- download: node ~/zylos/.claude/skills/ms-teams/scripts/download-attachments.js ${dlArgs}`;

  console.log(`[ms-teams/subs] Smart channel message from ${senderName}: ${text.substring(0, 50)}${hasAttachments ? ` (${graphAttachments.length} attachment(s))` : ''}...`);
  sendToC4('ms-teams', endpoint, msg);
}

// ── Teams Event Handlers ──

teamsApp.on('message', async (ctx) => {
  try {
    await handleMessage(ctx);
  } catch (err) {
    console.error(`[ms-teams] Error handling message: ${err.message}`);
    try {
      await ctx.send('Sorry, something went wrong processing your message.');
    } catch (sendErr) {
      console.error(`[ms-teams] Failed to send error response: ${sendErr.message}`);
    }
  }
});

teamsApp.on('conversationUpdate', async (ctx) => {
  try {
    const activity = ctx.activity;
    const conversationId = activity.conversation?.id || '';
    const convType = getConversationType(activity);
    const membersAdded = activity.membersAdded || [];

    for (const member of membersAdded) {
      if (member.id !== activity.recipient?.id) continue;

      console.log(`[ms-teams] Bot added to conversation: ${conversationId}`);
      await saveConvRef(activity, ctx.ref);

      if (convType === 'group' || convType === 'channel') {
        const adderAadId = activity.from?.aadObjectId || '';
        const adderName = activity.from?.name || 'unknown';

        if (access.isOwner(adderAadId)) {
          if (convType === 'channel') {
            if (!config.channels) config.channels = {};
            const baseChId = stripThreadId(conversationId);
            if (!config.channels[baseChId]) {
              const cd = activity.channelData || {};
              const teamId = cd.team?.aadGroupId || cd.team?.id || cd.teamId || '';
              const chatTitle = activity.conversation?.name || cd.channel?.name || 'channel';
              config.channels[baseChId] = {
                name: chatTitle,
                teamId,
                mode: 'mention',
                allowFrom: [],
                posts: {},
                added_at: new Date().toISOString(),
              };
              saveConfig(config);
              console.log(`[ms-teams] Auto-approved channel: ${chatTitle} (added by owner)`);
              try {
                await ctx.send(`Channel added. Members can @mention me to chat.`);
              } catch {}
            }
          } else {
            if (!config.groups) config.groups = {};
            if (!config.groups[conversationId]) {
              const chatTitle = activity.conversation?.name || 'group';
              config.groups[conversationId] = {
                name: chatTitle,
                mode: 'mention',
                allowFrom: [],
                added_at: new Date().toISOString(),
              };
              saveConfig(config);
              console.log(`[ms-teams] Auto-approved group: ${chatTitle} (added by owner)`);
              try {
                await ctx.send(`Group added. Members can @mention me to chat.`);
              } catch {}
            }
          }
        } else {
          console.log(`[ms-teams] Bot added by non-owner ${adderName} (${adderAadId}), pending approval`);
          try {
            await ctx.send('Bot joined, but requires admin approval to respond.');
          } catch {}
          if (config.owner?.aadObjectId) {
            const chatTitle = activity.conversation?.name || conversationId;
            const notifyMsg = `Bot was added to a group, pending approval:\nGroup: ${chatTitle}\nID: ${conversationId}\nAdded by: ${adderName}\n\nTo approve, run:\nzylos-ms-teams add-group "${conversationId}" "${chatTitle}"`;
            const allRefs = await getAllConversationReferences();
            const ownerDmRef = Object.entries(allRefs).find(([id, ref]) =>
              id.startsWith('a:') && ref.user?.aadObjectId === config.owner.aadObjectId
            );
            if (ownerDmRef) {
              try {
                await teamsApp.send(ownerDmRef[0], { type: 'message', text: notifyMsg });
                console.log(`[ms-teams] Notified owner about pending group: ${chatTitle}`);
              } catch (err) {
                console.warn(`[ms-teams] Failed to notify owner: ${err.message}`);
              }
            } else {
              console.log(`[ms-teams] No owner DM reference found. Pending group: ${chatTitle} (${conversationId})`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`[ms-teams] Error handling conversationUpdate: ${err.message}`);
  }
});

teamsApp.event('error', (event) => {
  console.error(`[ms-teams] App error: ${event?.error?.message || 'unknown error'}`);
});

// ── Lifecycle ──

let isShuttingDown = false;

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[ms-teams] Shutting down...');
  clearInterval(dedupCleanupInterval);
  stopRenewalLoop();
  stopWatching();
  for (const interval of typingIntervals.values()) clearInterval(interval);
  typingIntervals.clear();

  const finishExit = () => process.exit(0);
  httpServer.close(() => finishExit());
  setTimeout(finishExit, 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const PORT = config.port || 3978;
const MAX_LISTEN_RETRIES = 5;

async function startServerWithRetry(port, maxRetries = MAX_LISTEN_RETRIES) {
  await teamsApp.initialize();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          httpServer.off('error', onError);
          reject(err);
        };
        httpServer.once('error', onError);
        httpServer.listen(port, '127.0.0.1', () => {
          httpServer.off('error', onError);
          resolve();
        });
      });
      return;
    } catch (err) {
      if (err.code === 'EADDRINUSE' && attempt < maxRetries) {
        const delay = attempt * 1000;
        console.error(`[ms-teams] Port ${port} in use (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed to bind port ${port} after ${maxRetries} attempts`);
}

function validatePublicUrl(raw) {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') {
      console.warn(`[ms-teams] MSTEAMS_PUBLIC_URL is not HTTPS (${parsed.protocol}), ignoring`);
      return null;
    }
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    console.warn(`[ms-teams] MSTEAMS_PUBLIC_URL is malformed, ignoring`);
    return null;
  }
}

async function resolvePublicUrl() {
  const configured = validatePublicUrl(getPublicUrl());
  if (configured) return configured;
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    const tunnel = data.tunnels?.find(t => t.proto === 'https');
    if (tunnel) return tunnel.public_url;
  } catch {}
  return null;
}

async function initChannelSubscriptions() {
  if (!isGraphEnabled()) return;

  const channels = config.channels || {};
  const hasSmartChannels = Object.values(channels).some(c => c.mode === 'smart');

  if (!hasSmartChannels) {
    try {
      await syncSubscriptions({}, '');
      stopRenewalLoop();
    } catch {}
    return;
  }

  const publicUrl = await resolvePublicUrl();
  if (!publicUrl) {
    console.warn('[ms-teams/subs] No public URL found (set MSTEAMS_PUBLIC_URL in config or run ngrok). Channel subscriptions disabled.');
    return;
  }

  const notificationUrl = `${publicUrl.replace(/\/$/, '')}/api/notifications`;
  console.log(`[ms-teams/subs] Notification URL: ${notificationUrl}`);

  try {
    await syncSubscriptions(channels, notificationUrl);
    startRenewalLoop(notificationUrl);
    console.log(`[ms-teams/subs] Channel subscriptions active`);
  } catch (err) {
    console.error(`[ms-teams/subs] Failed to initialize subscriptions: ${err.message}`);
  }
}

(async () => {
  await startServerWithRetry(PORT);
  httpServer.on('error', (err) => {
    console.error(`[ms-teams] Server error: ${err.message}`);
  });
  console.log(`[ms-teams] HTTP server running on 127.0.0.1:${PORT}`);
  console.log(`[ms-teams] Bot identity: ${botName} (${botId || 'no app ID'})`);
  console.log(`[ms-teams] Credentials: ${credentials.appId ? 'configured' : 'MISSING'}`);
  console.log(`[ms-teams] DM policy: ${config.dmPolicy || 'owner'}, Group policy: ${config.groupPolicy || 'allowlist'}`);

  await initChannelSubscriptions();
})().catch((err) => {
  console.error(`[ms-teams] Fatal startup error: ${err.message}`);
  process.exit(1);
});
