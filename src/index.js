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

import { getConfig, watchConfig, saveConfig, stopWatching, DATA_DIR, getCredentials, resolveRouteConfig, isSmartConversation } from './lib/config.js';
import { createMessageDeduper, MESSAGE_DEDUP_TTL_MS } from './lib/message-dedup.js';
import { saveConversationReference, getConversationReference, getAllConversationReferences } from './lib/conversation-store.js';
import { htmlToText, extractQuotedReply, extractReplyBlockquote } from './lib/html.js';
import { createJwtMiddleware } from './lib/auth.js';
import { isGraphEnabled, fetchChatHistory, fetchChannelHistory, acquireTokenForScope } from './lib/graph.js';
import { resolveInboundMedia } from './lib/attachments.js';
import { escapeXml, buildEndpoint, parseC4Response, getConversationType, formatMessage } from './lib/format.js';
import { ensureReplay, logEntry } from './lib/context.js';
import { buildAuthUrl, validateState, exchangeCode, getDelegatedToken, hasAuth, sendReaction, removeReaction, getAuthenticatedUsers } from './lib/delegated-auth.js';
import { syncSubscriptions, startRenewalLoop, stopRenewalLoop, fetchMessage, fetchReplyMessage, getActiveSubscriptions } from './lib/channel-subscriptions.js';

const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex');
const REACTION_CACHE_FILE = path.join(DATA_DIR, 'reaction-cache.json');
const reactionContextCache = new Map();
const pendingReactions = new Map();

// Load persisted reaction context on startup
try {
  const cached = JSON.parse(fs.readFileSync(REACTION_CACHE_FILE, 'utf8'));
  for (const [k, v] of Object.entries(cached)) reactionContextCache.set(k, v);
} catch {}

function persistReactionCache() {
  try {
    const obj = Object.fromEntries(reactionContextCache);
    fs.writeFileSync(REACTION_CACHE_FILE, JSON.stringify(obj), 'utf8');
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
  execFileSync(TRANSCRIBE_SCRIPT, ['--check'], { timeout: 15000 });
  VOICE_ENABLED = true;
} catch {}
console.log(`[ms-teams] Voice ASR: ${VOICE_ENABLED ? 'enabled' : 'disabled (whisper or transcribe.py not found)'}`);

function transcribeAudio(audioPath) {
  return new Promise((resolve, reject) => {
    execFile(TRANSCRIBE_SCRIPT, [audioPath], { timeout: 90000, encoding: 'utf8' }, (err, stdout, stderr) => {
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

// In-memory group context history
const chatHistories = new Map();

function recordHistoryEntry(chatId, entry) {
  const key = String(chatId).split(';')[0];
  if (!chatHistories.has(key)) chatHistories.set(key, []);
  const history = chatHistories.get(key);

  if (entry.message_id && history.some(h => h.message_id === entry.message_id)) return;

  // Content-based dedup: normalize text (strip markdown) and compare within 10s window
  const normalize = t => (t || '').replace(/[*_`#\->\[\]()!]/g, '').replace(/\s+/g, ' ').trim().substring(0, 120);
  const entryNorm = normalize(entry.text);
  const entryTime = new Date(entry.timestamp).getTime();
  const recentDup = entryNorm && history.find(h =>
    normalize(h.text) === entryNorm &&
    Math.abs(new Date(h.timestamp).getTime() - entryTime) < 10000
  );
  if (recentDup) return;

  history.push(entry);
  if (!String(entry.message_id || '').startsWith('graph-')) {
    logEntry(chatId, entry);
  }

  const maxEntries = (config?.message?.context_messages || 10) * 2;
  if (history.length > maxEntries) {
    history.splice(0, history.length - maxEntries);
  }
}

function getInMemoryContext(chatId, currentMessageId, limit) {
  const key = String(chatId).split(';')[0];
  const history = chatHistories.get(key);
  if (!history || history.length === 0) return [];

  return history
    .filter(h => h.message_id !== currentMessageId)
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''))
    .slice(-limit);
}

function formatContextBlock(messages) {
  if (!messages || messages.length === 0) return '';
  const filtered = messages.filter(m => m.text && m.text.trim());
  if (filtered.length === 0) return '';
  const lines = filtered.map(m => `[${escapeXml(m.user_name || m.user_id)}]: ${escapeXml(m.text)}`);
  return `<group-context>\n${lines.join('\n')}\n</group-context>\n\n`;
}


// Load configuration
let config = getConfig();
console.log(`[ms-teams] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log('[ms-teams] Component disabled in config, exiting.');
  process.exit(0);
}

watchConfig(async (newConfig) => {
  console.log('[ms-teams] Config reloaded');
  config = newConfig;
  if (!newConfig.enabled) {
    console.log('[ms-teams] Component disabled, stopping...');
    shutdown();
    return;
  }
  // Re-sync channel subscriptions when config changes
  try {
    await initChannelSubscriptions();
  } catch (err) {
    console.warn(`[ms-teams/subs] Re-sync on config reload failed: ${err.message}`);
  }
});

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

// ── Express + HTTP Server (we manage binding to 127.0.0.1) ──

const expressApp = express();

// Custom JWT validation middleware — applied BEFORE body parsing on /api/messages
if (credentials.appId) {
  const jwtMiddleware = createJwtMiddleware({
    appId: credentials.appId,
    tenantId: credentials.tenantId || undefined,
  });
  expressApp.post('/api/messages', jwtMiddleware);
}

// Create HTTP server bound to our Express app
const httpServer = http.createServer(expressApp);

// ── Teams App SDK ──
// Pass our Express app to ExpressAdapter so the SDK registers routes on it.
// We manage the HTTP server lifecycle ourselves (bind to 127.0.0.1).
const adapter = new ExpressAdapter(expressApp);

const teamsApp = new App({
  clientId: credentials.appId || undefined,
  clientSecret: credentials.appPassword || undefined,
  tenantId: credentials.tenantId || undefined,
  httpServerAdapter: adapter,
  activity: {
    mentions: {
      stripText: false, // We handle mention stripping ourselves
    },
  },
});

// Owner binding
async function bindOwner(aadObjectId, name) {
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
  if (!config.owner?.bound) return false;
  return String(config.owner.aadObjectId) === String(aadObjectId);
}

// DM access check
function isDmAllowed(aadObjectId) {
  if (isOwner(aadObjectId)) return true;
  const policy = config.dmPolicy || 'owner';
  if (policy === 'open') return true;
  if (policy === 'owner') return false;
  const allowFrom = (config.dmAllowFrom || []).map(String);
  return allowFrom.includes(String(aadObjectId));
}

// Group access check
function stripThreadId(conversationId) {
  return conversationId.split(';')[0];
}

function isConversationAllowed(convType, conversationId) {
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
  const baseId = stripThreadId(conversationId);
  if (convType === 'channel') {
    const channels = config.channels || {};
    return channels[conversationId]?.name || channels[baseId]?.name || conversationId;
  }
  const groups = config.groups || {};
  return groups[conversationId]?.name || groups[baseId]?.name || conversationId;
}


// Teams mention entities use channel-specific IDs (e.g. "28:appId") rather than raw app IDs
function isBotMention(entity) {
  if (entity.type !== 'mention') return false;
  const mentionedId = String(entity.mentioned?.id || '');
  if (!mentionedId) return false;
  return mentionedId === botId || mentionedId.endsWith(`:${botId}`);
}

// Check if bot is mentioned in a group/channel message
function isBotMentioned(activity) {
  if (!activity.entities) return false;
  return activity.entities.some(isBotMention);
}

// Strip bot @mention from message text
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

function replaceBotMention(activity) {
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


/**
 * Send message to Claude via C4 (with 1 retry on unexpected failure).
 */
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

/**
 * Extract the best message content from a Teams activity.
 * When textFormat is "plain" and a text/html attachment exists,
 * Teams put the rich content (links, lists) in the attachment.
 * Also strips Skype Reply blockquotes (handled separately by extractQuotedReply).
 */
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


/**
 * Save a conversation reference with tenant ID.
 */
function saveConvRef(activity, ref) {
  const conversationId = activity.conversation?.id;
  if (!conversationId) return;

  const tenantId = activity.channelData?.tenant?.id
    || activity.conversation?.tenantId
    || credentials.tenantId
    || '';

  // Build a conversation reference compatible with Bot Framework format
  const convRef = ref || {
    activityId: activity.id,
    bot: activity.recipient,
    channelId: activity.channelId || 'msteams',
    conversation: activity.conversation,
    serviceUrl: activity.serviceUrl,
    user: activity.from,
  };

  saveConversationReference(conversationId, convRef, { tenantId });
}

/**
 * Handle incoming message activity.
 */
async function handleMessage(ctx) {
  const activity = ctx.activity;
  if (!activity) return;

  const activityId = activity.id;
  if (isDuplicate(activityId)) return;

  // Save conversation reference for proactive messaging
  saveConvRef(activity, ctx.ref);

  const senderAadObjectId = activity.from?.aadObjectId || '';
  const senderName = activity.from?.name || 'unknown';
  const conversationId = activity.conversation?.id || '';
  const convType = getConversationType(activity);

  // Extract message content — Teams may send rich HTML as an attachment
  // when textFormat is "plain" (links, lists, etc.)
  const rawText = extractMessageContent(activity);
  const text = htmlToText(rawText);

  // Extract quoted reply if present
  const quotedReply = extractQuotedReply(activity);

  console.log(`[ms-teams] ${convType} message from ${senderName} (${senderAadObjectId}): ${text.substring(0, 50)}...`);

  // Record in chat history (for group context), with bot mention stripped
  const historyText = htmlToText(stripBotMention(activity));
  recordHistoryEntry(conversationId, {
    timestamp: activity.timestamp || new Date().toISOString(),
    message_id: activityId,
    user_id: senderAadObjectId,
    user_name: senderName,
    text: historyText,
  });

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
      await bindOwner(senderAadObjectId, senderName);
    }

    if (!isDmAllowed(senderAadObjectId)) {
      console.log(`[ms-teams] DM from non-allowed user ${senderAadObjectId} (dmPolicy=${config.dmPolicy || 'owner'}), rejecting`);
      await ctx.send("Sorry, I'm not available for private messages. Please ask my owner to grant you access.");
      return;
    }

    // Auto-react on receipt (delegated auth, fire-and-forget)
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

    // Voice/audio transcription
    const audioFile = mediaFiles.find(m => {
      const ct = (m.contentType || '').toLowerCase();
      return ct.startsWith('audio/') || ct.startsWith('video/');
    });
    if (audioFile && VOICE_ENABLED) {
      try {
        const transcript = await transcribeAudio(audioFile.path);
        console.log(`[ms-teams] Voice transcribed: "${transcript.substring(0, 60)}"`);
        const msg = formatMessage('dm', senderName, `[Voice] ${transcript}`, { quotedReply });
        sendToC4('ms-teams', endpoint, msg, (errMsg) => rejectReply(errMsg));
        fs.unlink(audioFile.path, () => {});
        return;
      } catch (err) {
        console.error(`[ms-teams] Voice transcription error: ${err.message}`);
      }
    }

    let msg = formatMessage('dm', senderName, text, { quotedReply });
    for (const media of mediaFiles) msg += ` ---- file: ${escapeXml(media.path)}`;
    sendToC4('ms-teams', endpoint, msg, (errMsg) => rejectReply(errMsg));
    return;
  }

  // Group / channel handling
  if (convType === 'group' || convType === 'channel') {
    const senderIsOwner = isOwner(senderAadObjectId);
    const groupPolicy = config.groupPolicy || 'allowlist';
    const mentioned = isBotMentioned(activity);
    const routeConfig = resolveRouteConfig(convType, conversationId, config);
    const smart = isSmartConversation(config, convType, conversationId);
    const smartNoMention = smart && !mentioned;

    if (groupPolicy === 'disabled') {
      console.log(`[ms-teams] Group policy disabled, ignoring message from ${senderAadObjectId}`);
      return;
    }

    const allowedGroup = isConversationAllowed(convType, conversationId);

    if (routeConfig.allowFrom.length > 0 && !senderIsOwner) {
      if (!routeConfig.allowFrom.includes(senderAadObjectId)) {
        if (mentioned) {
          console.log(`[ms-teams] User ${senderAadObjectId} not in route allowFrom, rejecting`);
          await ctx.send("Sorry, you don't have access in this channel.");
        }
        return;
      }
    }

    if (!allowedGroup && !senderIsOwner) {
      if (mentioned) {
        console.log(`[ms-teams] Group ${conversationId} not allowed, rejecting`);
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

    // Auto-react on receipt (delegated auth, fire-and-forget)
    if (!smartNoMention) {
      const reactUser = hasAuth(senderAadObjectId) ? senderAadObjectId : getAuthenticatedUsers()[0]?.aadObjectId;
      if (reactUser) {
        if (convType === 'channel') {
          const cd = activity?.channelData || {};
          reactionContextCache.set(activityId, {
            teamId: cd.team?.aadGroupId || cd.team?.id || cd.teamId,
            channelId: cd.teamsChannelId || cd.channel?.id || cd.channelId,
          });
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
    let cleanText = htmlToText(replaceBotMention(groupActivity));
    // Fallback: HTML attachments use <span> for mentions instead of <at>,
    // so entity.text replacement may fail. Strip by display name after htmlToText.
    const botMentionEntity = activity.entities?.find(e => isBotMention(e));
    if (botMentionEntity?.mentioned?.name && cleanText.startsWith(botMentionEntity.mentioned.name)) {
      cleanText = cleanText.slice(botMentionEntity.mentioned.name.length).trim();
    }
    const groupName = getConversationName(convType, conversationId);

    // Build group context from in-memory history + optional Graph API fetch
    const convConfig = convType === 'channel'
      ? (config.channels?.[conversationId] || config.channels?.[stripThreadId(conversationId)])
      : (config.groups?.[conversationId] || config.groups?.[stripThreadId(conversationId)]);
    const contextLimit = convConfig?.historyLimit || config.message?.context_messages || 10;
    ensureReplay(conversationId, recordHistoryEntry, contextLimit);
    let contextMessages = getInMemoryContext(conversationId, activityId, contextLimit);

    if (isGraphEnabled()) {
      try {
        const cd = activity.channelData || {};
        const teamId = cd.team?.aadGroupId || cd.team?.id || cd.teamId || '';
        const channelId = cd.teamsChannelId || cd.channel?.id || cd.channelId || '';
        const threadMatch = conversationId.match(/;messageid=(\d+)/);
        const threadMessageId = threadMatch ? threadMatch[1] : '';
        const authUser = hasAuth(senderAadObjectId) ? senderAadObjectId : getAuthenticatedUsers()[0]?.aadObjectId;
        const delegatedToken = authUser ? await getDelegatedToken(authUser) : '';
        const graphMessages = teamId
          ? await fetchChannelHistory(teamId, channelId, contextLimit, threadMessageId, delegatedToken || '')
          : await fetchChatHistory(conversationId, contextLimit);
        for (const gm of graphMessages) {
          recordHistoryEntry(conversationId, {
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

    // Voice auto-download detection
    const allAtts = activity.attachments || [];
    if (allAtts.length > 0) {
      console.log(`[ms-teams] Attachments (${allAtts.length}): ${JSON.stringify(allAtts.map(a => ({ contentType: a.contentType, contentUrl: (a.contentUrl || '').substring(0, 120), name: a.name, content: typeof a.content === 'string' ? a.content.substring(0, 500) : JSON.stringify(a.content)?.substring(0, 500) })))}`);
    }
    if (smartNoMention) {
      console.log(`[ms-teams] Smart-no-mention debug: text=${JSON.stringify((activity.text || '').substring(0, 200))}, attachments=${JSON.stringify(allAtts.map(a => ({ contentType: a.contentType, contentUrl: a.contentUrl, name: a.name, content: typeof a.content === 'string' ? a.content.substring(0, 300) : JSON.stringify(a.content)?.substring(0, 300) })))}, channelData=${JSON.stringify(activity.channelData || {})}`);
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

    // Voice transcription in group flow
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
        const cd = activity.channelData || {};
        const tid = cd.team?.aadGroupId || cd.team?.id || cd.teamId || '';
        const chid = cd.teamsChannelId || cd.channel?.id || cd.channelId || '';
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
    sendToC4('ms-teams', endpoint, msg, (errMsg) => rejectReply(errMsg));
    return;
  }
}

// Register message handler with the Teams App SDK
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

// Handle conversation update (bot added/removed from conversation)
teamsApp.on('conversationUpdate', async (ctx) => {
  try {
    const activity = ctx.activity;
    const conversationId = activity.conversation?.id || '';
    const convType = getConversationType(activity);
    const membersAdded = activity.membersAdded || [];

    for (const member of membersAdded) {
      if (member.id !== activity.recipient?.id) continue;

      console.log(`[ms-teams] Bot added to conversation: ${conversationId}`);
      saveConvRef(activity, ctx.ref);

      // Auto-add handling for group chats and channels
      if (convType === 'group' || convType === 'channel') {
        const adderAadId = activity.from?.aadObjectId || '';
        const adderName = activity.from?.name || 'unknown';

        if (isOwner(adderAadId)) {
          if (convType === 'channel') {
            // Channel auto-add: store in config.channels
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
            // Group chat auto-add
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
          // Non-owner added bot → pending approval, notify owner
          console.log(`[ms-teams] Bot added by non-owner ${adderName} (${adderAadId}), pending approval`);
          try {
            await ctx.send('Bot joined, but requires admin approval to respond.');
          } catch {}
          // Notify owner via DM if we have their conversation reference
          if (config.owner?.aadObjectId) {
            const chatTitle = activity.conversation?.name || conversationId;
            const notifyMsg = `Bot was added to a group, pending approval:\nGroup: ${chatTitle}\nID: ${conversationId}\nAdded by: ${adderName}\n\nTo approve, run:\nzylos-ms-teams add-group "${conversationId}" "${chatTitle}"`;
            const allRefs = getAllConversationReferences();
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

// Error handler
teamsApp.event('error', (event) => {
  console.error(`[ms-teams] App error: ${event?.error?.message || 'unknown error'}`);
});

// ── Internal send endpoint (accessed by send.js via localhost) ──

expressApp.use('/internal/send', express.json());
expressApp.post('/internal/send', async (req, res) => {
  const token = req.headers['x-internal-token'];
  if (!token || token !== INTERNAL_TOKEN) {
    return res.status(403).json({ error: 'unauthorized' });
  }

  const { conversationId, text, type, replyToId } = req.body || {};
  if (!conversationId || !text) {
    return res.status(400).json({ error: 'missing conversationId or text' });
  }

  try {
    // Strip ;messageid= from conversationId for reference lookup
    const baseConvId = conversationId.split(';')[0];
    const reference = getConversationReference(baseConvId) || getConversationReference(conversationId);
    if (!reference) {
      return res.status(404).json({ error: 'no conversation reference found' });
    }

    // For channel threads, use Bot Connector REST API (replyToId creates visible threading)
    // For DMs/groups, replyToId has no visible effect — use teamsApp.send()
    if (type === 'channel' && replyToId && reference.serviceUrl) {
      const botToken = await acquireTokenForScope('https://api.botframework.com/.default');
      const serviceUrl = reference.serviceUrl.replace(/\/$/, '');
      const activity = {
        type: 'message',
        text,
        textFormat: 'markdown',
        conversation: { id: conversationId },
        replyToId,
      };
      const apiUrl = `${serviceUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
      const apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(activity),
      });
      if (!apiRes.ok) {
        const errText = await apiRes.text();
        throw new Error(`Bot Connector API failed (${apiRes.status}): ${errText}`);
      }
    } else {
      const activity = { type: 'message', text, textFormat: 'markdown' };
      await teamsApp.send(baseConvId, activity);
    }

    // Record bot's outgoing message in group context
    recordHistoryEntry(baseConvId, {
      timestamp: new Date().toISOString(),
      message_id: `bot:${Date.now()}`,
      user_id: 'bot',
      user_name: botName,
      text: text.substring(0, 500),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(`[ms-teams] Internal send error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Internal media send endpoint ──

expressApp.use('/internal/send-media', express.json());
expressApp.post('/internal/send-media', async (req, res) => {
  const token = req.headers['x-internal-token'];
  if (!token || token !== INTERNAL_TOKEN) {
    return res.status(403).json({ error: 'unauthorized' });
  }

  const { conversationId, mediaType, filePath } = req.body || {};
  if (!conversationId || !filePath) {
    return res.status(400).json({ error: 'missing conversationId or filePath' });
  }

  try {
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'file not found' });
    }

    const reference = getConversationReference(conversationId);
    if (!reference) {
      return res.status(404).json({ error: 'no conversation reference found' });
    }

    if (mediaType === 'image') {
      const imageData = fs.readFileSync(filePath);
      const ext = path.extname(filePath).slice(1) || 'png';
      const base64 = imageData.toString('base64');
      const contentUrl = `data:image/${ext};base64,${base64}`;

      await teamsApp.send(conversationId, {
        type: 'message',
        text: '',
        attachments: [{
          contentType: `image/${ext}`,
          contentUrl,
          name: path.basename(filePath),
        }],
      });
    } else {
      const fileName = path.basename(filePath);
      await teamsApp.send(conversationId, {
        type: 'message',
        text: `📎 ${fileName}`,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(`[ms-teams] Internal send-media error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──

expressApp.get('/health', (req, res) => {
  const healthConfig = getConfig();
  res.json({
    status: 'ok',
    service: 'zylos-ms-teams',
    uptime: Math.floor(process.uptime()),
    hasCredentials: !!(credentials.appId && credentials.appPassword),
    hasGraph: isGraphEnabled(),
    groupPolicy: healthConfig.groupPolicy || 'allowlist',
    dmPolicy: healthConfig.dmPolicy || 'owner'
  });
});

// ── Delegated Auth: OAuth callback ──

expressApp.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error(`[ms-teams/auth] OAuth error: ${error} — ${error_description}`);
    return res.status(400).send(`Authentication failed: ${error_description || error}`);
  }

  if (!code || !state) {
    return res.status(400).send('Missing code or state parameter.');
  }

  if (!validateState(state)) {
    return res.status(400).send('Invalid or expired state. Please try signing in again.');
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  const redirectUri = `${protocol}://${host}/auth/callback`;

  try {
    const { aadObjectId, displayName } = await exchangeCode(code, state, redirectUri);
    res.send(`<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Signed in successfully</h2><p>${displayName}, your delegated auth is now active.</p><p>You can close this tab and return to Teams.</p></body></html>`);
  } catch (err) {
    console.error(`[ms-teams/auth] Token exchange failed: ${err.message}`);
    res.status(500).send('Authentication failed. Please try again.');
  }
});

expressApp.get('/auth/sign-in', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  const redirectUri = `${protocol}://${host}/auth/callback`;

  try {
    const { url } = buildAuthUrl(redirectUri);
    res.redirect(url);
  } catch (err) {
    res.status(500).send(`Failed to build auth URL: ${err.message}`);
  }
});

// ── Internal reaction endpoint ──

expressApp.use('/internal/react', express.json());
expressApp.post('/internal/react', async (req, res) => {
  const token = req.headers['x-internal-token'];
  if (!token || token !== INTERNAL_TOKEN) {
    return res.status(403).json({ error: 'unauthorized' });
  }

  const { conversationId, messageId, reactionType, aadObjectId, conversationType, teamId, channelId, action } = req.body || {};

  // Remove all pending reactions for a conversation
  if (action === 'remove-all' && conversationId && reactionType) {
    const pending = pendingReactions.get(conversationId) || [];
    pendingReactions.delete(conversationId);
    if (pending.length === 0) return res.json({ ok: true, removed: 0 });

    const authUser = aadObjectId || config.owner?.aadObjectId;
    if (!authUser || !hasAuth(authUser)) {
      return res.status(400).json({ error: 'no delegated auth available' });
    }

    let removed = 0;
    for (const entry of pending) {
      try {
        let rTeamId, rChannelId;
        if (entry.conversationType === 'channel') {
          const cached = reactionContextCache.get(entry.messageId);
          if (cached) { rTeamId = cached.teamId; rChannelId = cached.channelId; }
        }
        const act = rTeamId ? { channelData: { team: { aadGroupId: rTeamId, id: rTeamId }, channel: { id: rChannelId }, teamsChannelId: rChannelId } } : (entry.activity || {});
        await removeReaction({
          aadObjectId: authUser,
          conversationType: entry.conversationType || 'group',
          conversationId,
          messageId: entry.messageId,
          reactionType,
          activity: act,
        });
        removed++;
      } catch (err) {
        console.debug(`[ms-teams] Remove pending reaction ${entry.messageId}: ${err.message}`);
      }
    }
    return res.json({ ok: true, removed });
  }

  if (!conversationId || !messageId || !reactionType) {
    return res.status(400).json({ error: 'missing conversationId, messageId, or reactionType' });
  }

  const authUser = aadObjectId || config.owner?.aadObjectId;
  if (!authUser || !hasAuth(authUser)) {
    return res.status(400).json({ error: 'no delegated auth available — user must sign in first' });
  }

  try {
    let resolvedTeamId = teamId;
    let resolvedChannelId = channelId;
    if (conversationType === 'channel' && !resolvedTeamId) {
      const cached = reactionContextCache.get(messageId);
      if (cached) {
        resolvedTeamId = cached.teamId;
        resolvedChannelId = cached.channelId;
      }
    }
    const activity = resolvedTeamId ? { channelData: { team: { aadGroupId: resolvedTeamId, id: resolvedTeamId }, channel: { id: resolvedChannelId }, teamsChannelId: resolvedChannelId } } : {};
    const reactionFn = action === 'remove' ? removeReaction : sendReaction;
    await reactionFn({
      aadObjectId: authUser,
      conversationType: conversationType || 'group',
      conversationId,
      messageId,
      reactionType,
      activity,
    });
    if (action === 'remove') {
      const pending = pendingReactions.get(conversationId);
      if (pending) {
        const idx = pending.findIndex(e => e.messageId === messageId);
        if (idx !== -1) pending.splice(idx, 1);
        if (pending.length === 0) pendingReactions.delete(conversationId);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(`[ms-teams] Internal react error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Graph Change Notifications (channel smart mode) ──

expressApp.use('/api/notifications', express.json());
expressApp.post('/api/notifications', async (req, res) => {
  // Subscription validation handshake
  if (req.query.validationToken) {
    console.log('[ms-teams/subs] Validation handshake received');
    res.set('Content-Type', 'text/plain');
    return res.status(200).send(req.query.validationToken);
  }

  res.status(202).send();

  const notifications = req.body?.value || [];
  for (const notification of notifications) {
    try {
      await handleChannelNotification(notification);
    } catch (err) {
      console.error(`[ms-teams/subs] Notification error: ${err.message}`);
    }
  }
});

async function handleChannelNotification(notification) {
  const resource = notification.resource || '';
  // resource: teams('teamId')/channels('channelId')/messages('msgId') or .../replies('replyId')
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

  // Fetch the full message via Graph
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

  // Skip bot's own messages
  if (graphMsg.from?.application?.id === credentials.appId) return;

  // Skip system/event messages
  if (graphMsg.messageType && graphMsg.messageType !== 'message') return;

  // Skip if channel is no longer in smart mode (stale subscription)
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

  // Dedup: skip if this message was already processed via @mention delivery
  if (isDuplicate(`graph-${messageId}`)) return;

  // Check if bot is @mentioned — if so, the normal Bot Framework path handles it
  const mentions = graphMsg.mentions || [];
  const botMentioned = mentions.some(m =>
    m.mentioned?.application?.id === credentials.appId
  );
  if (botMentioned) return;

  // Access control
  const senderIsOwner = isOwner(senderAadId);
  const conversationId = channelId;

  if (!isConversationAllowed('channel', conversationId) && !senderIsOwner) return;

  const routeConfig = resolveRouteConfig('channel', conversationId, config);
  if (routeConfig.allowFrom.length > 0 && !senderIsOwner) {
    if (!routeConfig.allowFrom.includes(senderAadId)) return;
  }

  // Record in history
  const threadConversationId = rootMessageId
    ? `${channelId};messageid=${rootMessageId}`
    : channelId;

  recordHistoryEntry(threadConversationId, {
    timestamp: graphMsg.createdDateTime || new Date().toISOString(),
    message_id: messageId,
    user_id: senderAadId,
    user_name: senderName,
    text,
  });

  const channelName = getConversationName('channel', conversationId);

  // Build context
  const contextLimit = config.channels?.[conversationId]?.historyLimit
    || config.message?.context_messages || 10;
  ensureReplay(threadConversationId, recordHistoryEntry, contextLimit);
  const contextMessages = getInMemoryContext(threadConversationId, messageId, contextLimit);
  const contextBlock = formatContextBlock(contextMessages);

  // Build message with smart hint
  let msg = formatMessage('channel', senderName, text, {
    groupName: channelName,
    contextBlock,
    smartHint: true,
  });

  // Build endpoint for reply
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

// ── Lifecycle ──

let isShuttingDown = false;

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[ms-teams] Shutting down...');
  clearInterval(dedupCleanupInterval);
  stopRenewalLoop();
  stopWatching();

  const finishExit = () => process.exit(0);
  httpServer.close(() => finishExit());
  setTimeout(finishExit, 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const PORT = config.port || 3978;
const MAX_LISTEN_RETRIES = 5;

async function startServerWithRetry(port, maxRetries = MAX_LISTEN_RETRIES) {
  // Initialize the Teams SDK (registers /api/messages on our Express app)
  // We call initialize() directly instead of start() because we manage the
  // HTTP server ourselves to bind to 127.0.0.1 specifically.
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

async function getPublicUrl() {
  if (process.env.MSTEAMS_PUBLIC_URL) return process.env.MSTEAMS_PUBLIC_URL;
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels');
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
    // Clean up any stale subscriptions when no smart channels
    try {
      await syncSubscriptions({}, '');
      stopRenewalLoop();
    } catch {}
    return;
  }

  const publicUrl = await getPublicUrl();
  if (!publicUrl) {
    console.warn('[ms-teams/subs] No public URL found (set MSTEAMS_PUBLIC_URL or run ngrok). Channel subscriptions disabled.');
    return;
  }

  const notificationUrl = `${publicUrl.replace(/\/$/, '')}/api/notifications`;
  console.log(`[ms-teams/subs] Notification URL: ${notificationUrl}`);

  try {
    await syncSubscriptions(channels, notificationUrl);
    startRenewalLoop();
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
