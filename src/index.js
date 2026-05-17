#!/usr/bin/env node
/**
 * zylos-teams - Microsoft Teams Bot Service
 *
 * Uses @microsoft/teams.apps v2 SDK for receiving/sending Teams messages
 * and routes inbound messages to Claude via C4 Communication Bridge.
 */

import dotenv from 'dotenv';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { App, ExpressAdapter } from '@microsoft/teams.apps';

import { getConfig, watchConfig, saveConfig, stopWatching, DATA_DIR, getCredentials, resolveRouteConfig, isSmartGroup } from './lib/config.js';
import { createMessageDeduper, MESSAGE_DEDUP_TTL_MS } from './lib/message-dedup.js';
import { saveConversationReference, getConversationReference, getAllConversationReferences } from './lib/conversation-store.js';
import { htmlToText, extractQuotedReply, extractReplyBlockquote } from './lib/html.js';
import { createJwtMiddleware } from './lib/auth.js';
import { isGraphEnabled, fetchChatHistory, fetchChannelHistory, formatGroupContext } from './lib/graph.js';
import { resolveInboundMedia } from './lib/attachments.js';
import { escapeXml, buildEndpoint, parseC4Response, getConversationType, formatMessage } from './lib/format.js';
import { ensureReplay } from './lib/context.js';

const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex');
const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_TOKEN, { mode: 0o600 });
} catch (err) {
  console.error(`[teams] Failed to write internal token file: ${err.message}`);
}

console.log('[teams] Starting...');
console.log(`[teams] Data directory: ${DATA_DIR}`);

const TRANSCRIBE_SCRIPT = path.join(process.env.HOME, 'zylos/bin/transcribe');
const VOICE_ENABLED = fs.existsSync(TRANSCRIBE_SCRIPT);
if (!VOICE_ENABLED) {
  console.log('[teams] Voice ASR not available (~/zylos/bin/transcribe not found) — voice messages will be forwarded as attachments');
}

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
    console.log(`[teams] Duplicate activity ${messageId}, skipping`);
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
  const key = String(chatId);
  if (!chatHistories.has(key)) chatHistories.set(key, []);
  const history = chatHistories.get(key);

  if (entry.message_id && history.some(h => h.message_id === entry.message_id)) return;

  // Content-based dedup (same user + same text within 5s window)
  const recentDup = history.find(h =>
    h.user_id === entry.user_id &&
    h.text === entry.text &&
    Math.abs(new Date(h.timestamp).getTime() - new Date(entry.timestamp).getTime()) < 5000
  );
  if (recentDup) return;

  history.push(entry);

  const maxEntries = (config?.message?.context_messages || 10) * 2;
  if (history.length > maxEntries) {
    history.splice(0, history.length - maxEntries);
  }
}

function getInMemoryContext(chatId, currentMessageId, limit) {
  const key = String(chatId);
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
console.log(`[teams] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log('[teams] Component disabled in config, exiting.');
  process.exit(0);
}

watchConfig((newConfig) => {
  console.log('[teams] Config reloaded');
  config = newConfig;
  if (!newConfig.enabled) {
    console.log('[teams] Component disabled, stopping...');
    shutdown();
  }
});

// Credentials check
const credentials = getCredentials();
if (!credentials.appId || !credentials.appPassword) {
  console.error('[teams] WARNING: MSTEAMS_APP_ID and/or MSTEAMS_APP_PASSWORD not set in ~/zylos/.env');
  console.error('[teams] The bot will start but cannot authenticate with Teams.');
  console.error('[teams] Set credentials and restart: pm2 restart zylos-teams');
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
    console.error('[teams] Failed to persist owner binding');
    return null;
  }
  console.log(`[teams] Owner bound: ${name} (${aadObjectId})`);
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
function isGroupAllowed(conversationId) {
  const groupPolicy = config.groupPolicy || 'allowlist';
  if (groupPolicy === 'disabled') return false;
  if (groupPolicy === 'open') return true;
  const groups = config.groups || {};
  return !!groups[conversationId];
}

function getGroupName(conversationId) {
  const groups = config.groups || {};
  return groups[conversationId]?.name || conversationId;
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
    console.error('[teams] sendToC4 called with empty content');
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
      console.log(`[teams] Sent to C4: ${content.substring(0, 50)}...`);
      return;
    }
    const response = parseC4Response(error.stdout || stdout);
    if (response && response.ok === false && response.error?.message) {
      console.warn(`[teams] C4 rejected (${response.error.code}): ${response.error.message}`);
      if (onReject) onReject(response.error.message);
      return;
    }
    console.warn(`[teams] C4 send failed, retrying in 2s: ${error.message}`);
    setTimeout(() => {
      execFile('node', args, { encoding: 'utf8', timeout: 35000 }, (retryError, retryStdout) => {
        if (!retryError) {
          console.log(`[teams] Sent to C4 (retry): ${content.substring(0, 50)}...`);
          return;
        }
        const retryResponse = parseC4Response(retryError.stdout || retryStdout);
        if (retryResponse && retryResponse.ok === false && retryResponse.error?.message) {
          console.error(`[teams] C4 rejected after retry (${retryResponse.error.code}): ${retryResponse.error.message}`);
          if (onReject) onReject(retryResponse.error.message);
        } else {
          console.error(`[teams] C4 send failed after retry: ${retryError.message}`);
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

  console.log(`[teams] ${convType} message from ${senderName} (${senderAadObjectId}): ${text.substring(0, 50)}...`);

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
    return resolveInboundMedia({
      attachments: activity.attachments,
      conversationType: convType,
      conversationId,
      serviceUrl: activity.serviceUrl,
      activity,
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
      console.error(`[teams] Failed to send reject reply: ${err.message}`);
    }
  };

  if (convType === 'dm') {
    if (!config.owner?.bound) {
      await bindOwner(senderAadObjectId, senderName);
    }

    if (!isDmAllowed(senderAadObjectId)) {
      console.log(`[teams] DM from non-allowed user ${senderAadObjectId} (dmPolicy=${config.dmPolicy || 'owner'}), rejecting`);
      await ctx.send("Sorry, I'm not available for private messages. Please ask my owner to grant you access.");
      return;
    }

    // Send typing indicator for DMs (after access check)
    try {
      await teamsApp.send(activity.conversation?.id, { type: 'typing' });
    } catch {}

    const mediaFiles = await downloadMedia();

    // Voice/audio transcription
    const audioFile = mediaFiles.find(m => {
      const ct = (m.contentType || '').toLowerCase();
      return ct.startsWith('audio/') || ct.startsWith('video/');
    });
    if (audioFile && VOICE_ENABLED) {
      try {
        const transcript = await transcribeAudio(audioFile.path);
        console.log(`[teams] Voice transcribed: "${transcript.substring(0, 60)}"`);
        const msg = formatMessage('dm', senderName, `[Voice] ${transcript}`, { quotedReply });
        sendToC4('teams', endpoint, msg, (errMsg) => rejectReply(errMsg));
        fs.unlink(audioFile.path, () => {});
        return;
      } catch (err) {
        console.error(`[teams] Voice transcription error: ${err.message}`);
      }
    }

    let msg = formatMessage('dm', senderName, text, { quotedReply });
    for (const media of mediaFiles) msg += ` ---- file: ${escapeXml(media.path)}`;
    sendToC4('teams', endpoint, msg, (errMsg) => rejectReply(errMsg));
    return;
  }

  // Group / channel handling
  if (convType === 'group' || convType === 'channel') {
    const senderIsOwner = isOwner(senderAadObjectId);
    const groupPolicy = config.groupPolicy || 'allowlist';
    const mentioned = isBotMentioned(activity);
    const routeConfig = resolveRouteConfig(activity, config);
    const smart = isSmartGroup(config, conversationId);
    const smartNoMention = smart && !mentioned;

    if (groupPolicy === 'disabled') {
      console.log(`[teams] Group policy disabled, ignoring message from ${senderAadObjectId}`);
      return;
    }

    const allowedGroup = isGroupAllowed(conversationId);

    if (routeConfig.allowFrom.length > 0 && !senderIsOwner) {
      if (!routeConfig.allowFrom.includes(senderAadObjectId)) {
        if (mentioned) {
          console.log(`[teams] User ${senderAadObjectId} not in route allowFrom, rejecting`);
          await ctx.send("Sorry, you don't have access in this channel.");
        }
        return;
      }
    }

    if (!allowedGroup && !senderIsOwner) {
      if (mentioned) {
        console.log(`[teams] Group ${conversationId} not allowed, rejecting`);
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

    // Typing indicator only when directly addressed
    if (!smartNoMention) {
      try {
        await teamsApp.send(activity.conversation?.id, { type: 'typing' });
      } catch {}
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
    const groupName = getGroupName(conversationId);

    // Build group context from in-memory history + optional Graph API fetch
    const contextLimit = config.groups?.[conversationId]?.historyLimit
      || config.message?.context_messages || 10;
    ensureReplay(conversationId, recordHistoryEntry, contextLimit);
    let contextMessages = getInMemoryContext(conversationId, activityId, contextLimit);

    if (contextMessages.length === 0 && isGraphEnabled()) {
      try {
        const teamId = activity.channelData?.team?.id || '';
        const graphMessages = teamId
          ? await fetchChannelHistory(teamId, conversationId, contextLimit)
          : await fetchChatHistory(conversationId, contextLimit);
        for (const gm of graphMessages) {
          recordHistoryEntry(conversationId, {
            timestamp: gm.time,
            message_id: `graph-${gm.time}`,
            user_id: gm.from,
            user_name: gm.from,
            text: gm.body,
          });
        }
        contextMessages = getInMemoryContext(conversationId, activityId, contextLimit);
      } catch (err) {
        console.warn(`[teams] Graph context fetch failed: ${err.message}`);
      }
    }

    const contextBlock = formatContextBlock(contextMessages);

    // Voice auto-download detection
    const allAtts = activity.attachments || [];
    if (smartNoMention) {
      console.log(`[teams] Smart-no-mention debug: text=${JSON.stringify((activity.text || '').substring(0, 200))}, attachments=${JSON.stringify(allAtts.map(a => ({ contentType: a.contentType, contentUrl: a.contentUrl, name: a.name, content: typeof a.content === 'string' ? a.content.substring(0, 300) : JSON.stringify(a.content)?.substring(0, 300) })))}, channelData=${JSON.stringify(activity.channelData || {})}`);
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
          console.log(`[teams] Voice transcribed (group): "${transcript.substring(0, 60)}"`);
          cleanText = `[Voice] ${transcript}`;
          fs.unlink(audioFile.path, () => {});
        } catch (err) {
          console.error(`[teams] Voice transcription error: ${err.message}`);
        }
      }
    }

    let msg = formatMessage(convType, senderName, cleanText, {
      groupName, quotedReply, contextBlock, smartHint: smartNoMention && !hasVoiceAttachment,
    });
    if (smartNoMention && hasAttachments && !hasVoiceAttachment) {
      msg += ' [attachments not downloaded — smart mode, no @mention]';
    }
    for (const media of mediaFiles) {
      if (media.contentType?.startsWith('audio/') || media.contentType?.startsWith('video/')) continue;
      msg += ` ---- file: ${escapeXml(media.path)}`;
    }
    sendToC4('teams', endpoint, msg, (errMsg) => rejectReply(errMsg));
    return;
  }
}

// Register message handler with the Teams App SDK
teamsApp.on('message', async (ctx) => {
  try {
    await handleMessage(ctx);
  } catch (err) {
    console.error(`[teams] Error handling message: ${err.message}`);
    try {
      await ctx.send('Sorry, something went wrong processing your message.');
    } catch (sendErr) {
      console.error(`[teams] Failed to send error response: ${sendErr.message}`);
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

      console.log(`[teams] Bot added to conversation: ${conversationId}`);
      saveConvRef(activity, ctx.ref);

      // Auto-add handling for group chats
      if (convType === 'group' || convType === 'channel') {
        const adderAadId = activity.from?.aadObjectId || '';
        const adderName = activity.from?.name || 'unknown';

        if (isOwner(adderAadId)) {
          // Owner added bot → auto-approve group
          if (!config.groups) config.groups = {};
          if (!config.groups[conversationId]) {
            const chatTitle = activity.conversation?.name || 'group';
            config.groups[conversationId] = {
              name: chatTitle,
              allowFrom: [],
              added_at: new Date().toISOString(),
            };
            saveConfig(config);
            console.log(`[teams] Auto-approved group: ${chatTitle} (added by owner)`);
            try {
              await ctx.send(`Group added. Members can @mention me to chat.`);
            } catch {}
          }
        } else {
          // Non-owner added bot → pending approval, notify owner
          console.log(`[teams] Bot added by non-owner ${adderName} (${adderAadId}), pending approval`);
          try {
            await ctx.send('Bot joined, but requires admin approval to respond.');
          } catch {}
          // Notify owner via DM if we have their conversation reference
          if (config.owner?.aadObjectId) {
            const chatTitle = activity.conversation?.name || conversationId;
            const notifyMsg = `Bot was added to a group, pending approval:\nGroup: ${chatTitle}\nID: ${conversationId}\nAdded by: ${adderName}\n\nTo approve, run:\nzylos-teams add-group "${conversationId}" "${chatTitle}"`;
            const allRefs = getAllConversationReferences();
            const ownerDmRef = Object.entries(allRefs).find(([id, ref]) =>
              id.startsWith('a:') && ref.user?.aadObjectId === config.owner.aadObjectId
            );
            if (ownerDmRef) {
              try {
                await teamsApp.send(ownerDmRef[0], { type: 'message', text: notifyMsg });
                console.log(`[teams] Notified owner about pending group: ${chatTitle}`);
              } catch (err) {
                console.warn(`[teams] Failed to notify owner: ${err.message}`);
              }
            } else {
              console.log(`[teams] No owner DM reference found. Pending group: ${chatTitle} (${conversationId})`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`[teams] Error handling conversationUpdate: ${err.message}`);
  }
});

// Error handler
teamsApp.event('error', (event) => {
  console.error(`[teams] App error: ${event?.error?.message || 'unknown error'}`);
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
    const reference = getConversationReference(conversationId);
    if (!reference) {
      return res.status(404).json({ error: 'no conversation reference found' });
    }

    const activity = { type: 'message', text, textFormat: 'markdown' };
    if (replyToId) activity.replyToId = replyToId;

    await teamsApp.send(conversationId, activity);

    // Record bot's outgoing message in group context
    recordHistoryEntry(conversationId, {
      timestamp: new Date().toISOString(),
      message_id: `bot:${Date.now()}`,
      user_id: 'bot',
      user_name: botName,
      text: text.substring(0, 500),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(`[teams] Internal send error: ${err.message}`);
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
    console.error(`[teams] Internal send-media error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──

expressApp.get('/health', (req, res) => {
  const healthConfig = getConfig();
  res.json({
    status: 'ok',
    service: 'zylos-teams',
    uptime: Math.floor(process.uptime()),
    hasCredentials: !!(credentials.appId && credentials.appPassword),
    hasGraph: isGraphEnabled(),
    groupPolicy: healthConfig.groupPolicy || 'allowlist',
    dmPolicy: healthConfig.dmPolicy || 'owner'
  });
});

// ── Lifecycle ──

let isShuttingDown = false;

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[teams] Shutting down...');
  clearInterval(dedupCleanupInterval);
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
        console.error(`[teams] Port ${port} in use (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed to bind port ${port} after ${maxRetries} attempts`);
}

(async () => {
  await startServerWithRetry(PORT);
  httpServer.on('error', (err) => {
    console.error(`[teams] Server error: ${err.message}`);
  });
  console.log(`[teams] HTTP server running on 127.0.0.1:${PORT}`);
  console.log(`[teams] Bot identity: ${botName} (${botId || 'no app ID'})`);
  console.log(`[teams] Credentials: ${credentials.appId ? 'configured' : 'MISSING'}`);
  console.log(`[teams] DM policy: ${config.dmPolicy || 'owner'}, Group policy: ${config.groupPolicy || 'allowlist'}`);
})().catch((err) => {
  console.error(`[teams] Fatal startup error: ${err.message}`);
  process.exit(1);
});
