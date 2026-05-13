#!/usr/bin/env node
/**
 * zylos-teams - Microsoft Teams Bot Service
 *
 * Uses @microsoft/teams.apps v2 SDK for receiving/sending Teams messages
 * and routes inbound messages to Claude via C4 Communication Bridge.
 */

import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { App, ExpressAdapter } from '@microsoft/teams.apps';

import { getConfig, watchConfig, saveConfig, stopWatching, DATA_DIR, getCredentials, resolveRouteConfig } from './lib/config.js';
import { createMessageDeduper, MESSAGE_DEDUP_TTL_MS } from './lib/message-dedup.js';
import { saveConversationReference, getConversationReference } from './lib/conversation-store.js';
import { htmlToText, extractQuotedReply } from './lib/html.js';
import { createJwtMiddleware } from './lib/auth.js';

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

const LOGS_DIR = path.join(DATA_DIR, 'logs');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

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

// Determine conversation type from Teams activity
function getConversationType(activity) {
  const conversationType = activity.conversation?.conversationType;
  if (conversationType === 'personal') return 'dm';
  if (conversationType === 'groupChat') return 'group';
  if (conversationType === 'channel') return 'channel';
  return 'dm';
}

// Check if bot is mentioned in a group/channel message
function isBotMentioned(activity) {
  if (!activity.entities) return false;
  return activity.entities.some(entity => {
    if (entity.type !== 'mention') return false;
    const mentionedId = entity.mentioned?.id;
    if (!mentionedId) return false;
    return String(mentionedId) === String(botId);
  });
}

// Strip bot @mention from message text
function stripBotMention(activity) {
  let text = activity.text || '';
  if (!activity.entities) return text;
  for (const entity of activity.entities) {
    if (entity.type !== 'mention') continue;
    const mentionedId = entity.mentioned?.id;
    if (String(mentionedId) === String(botId) && entity.text) {
      text = text.replace(entity.text, '').trim();
    }
  }
  return text;
}

/**
 * Build structured endpoint string for C4.
 * Format: conversationId|type:dm|user:aadObjectId|msg:activityId
 */
function buildEndpoint(conversationId, { type, aadObjectId, activityId } = {}) {
  let endpoint = conversationId;
  if (type) endpoint += `|type:${type}`;
  if (aadObjectId) endpoint += `|user:${aadObjectId}`;
  if (activityId) endpoint += `|msg:${activityId}`;
  return endpoint;
}

/**
 * Parse C4 response from stdout.
 */
function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
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

function escapeXml(text) {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

/**
 * Format message for C4 using XML-structured tags.
 */
function formatMessage(type, userName, text, { groupName, quotedReply } = {}) {
  const prefix = type === 'dm'
    ? '[Teams DM]'
    : `[Teams GROUP:${escapeXml(groupName || 'unknown')}]`;
  const safeUserName = escapeXml(userName);
  const safeText = escapeXml(text);

  let content = `${prefix} ${safeUserName} said: <current-message>\n${safeText}\n</current-message>`;

  if (quotedReply) {
    const safeQuotedFrom = escapeXml(quotedReply.quotedFrom);
    const safeQuotedText = escapeXml(quotedReply.quotedText);
    content += `\n<quoted-reply from="${safeQuotedFrom}">${safeQuotedText}</quoted-reply>`;
  }

  return content;
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

  // Process HTML to plain text
  const rawText = activity.text || '';
  const text = htmlToText(rawText);

  // Extract quoted reply if present
  const quotedReply = extractQuotedReply(activity);

  console.log(`[teams] ${convType} message from ${senderName} (${senderAadObjectId}): ${text.substring(0, 50)}...`);

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

    const msg = formatMessage('dm', senderName, text, { quotedReply });
    sendToC4('teams', endpoint, msg, (errMsg) => rejectReply(errMsg));
    return;
  }

  // Group / channel handling
  if (convType === 'group' || convType === 'channel') {
    const senderIsOwner = isOwner(senderAadObjectId);
    const groupPolicy = config.groupPolicy || 'allowlist';
    const mentioned = isBotMentioned(activity);
    const routeConfig = resolveRouteConfig(activity, config);

    if (groupPolicy === 'disabled') {
      console.log(`[teams] Group policy disabled, ignoring message from ${senderAadObjectId}`);
      return;
    }

    const allowedGroup = isGroupAllowed(conversationId);

    // Check route-level allowFrom (if set, user must be in the list or be owner)
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

    // Determine whether mention is required
    const requireMention = routeConfig.requireMention;

    if (requireMention && !mentioned && !senderIsOwner) {
      console.log(`[teams] Group message without @mention (requireMention=true), ignoring`);
      return;
    }

    if (!mentioned && senderIsOwner && !allowedGroup) {
      // Owner in non-allowed group without mention: process as owner override
    }

    const cleanText = htmlToText(stripBotMention(activity));
    const groupName = getGroupName(conversationId);
    const msg = formatMessage(convType, senderName, cleanText, { groupName, quotedReply });
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

// Handle conversation update (bot added to conversation)
teamsApp.on('conversationUpdate', async (ctx) => {
  try {
    const activity = ctx.activity;
    const membersAdded = activity.membersAdded || [];
    for (const member of membersAdded) {
      if (member.id === activity.recipient?.id) {
        console.log(`[teams] Bot added to conversation: ${activity.conversation?.id}`);
        saveConvRef(activity, ctx.ref);
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

  const { conversationId, text, type } = req.body || {};
  if (!conversationId || !text) {
    return res.status(400).json({ error: 'missing conversationId or text' });
  }

  try {
    const reference = getConversationReference(conversationId);
    if (!reference) {
      return res.status(404).json({ error: 'no conversation reference found' });
    }

    // Use the App's send method for proactive messaging
    await teamsApp.send(conversationId, { type: 'message', text });

    res.json({ ok: true });
  } catch (err) {
    console.error(`[teams] Internal send error: ${err.message}`);
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
