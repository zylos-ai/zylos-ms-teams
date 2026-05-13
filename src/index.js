#!/usr/bin/env node
/**
 * zylos-teams - Microsoft Teams Bot Service
 *
 * Bot Framework adapter for receiving Teams messages and routing to Claude via C4.
 */

import dotenv from 'dotenv';
import express from 'express';
import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ActivityTypes,
  TurnContext,
} from 'botbuilder';

import { getConfig, watchConfig, saveConfig, stopWatching, DATA_DIR, getCredentials } from './lib/config.js';
import { createMessageDeduper, MESSAGE_DEDUP_TTL_MS } from './lib/message-dedup.js';
import { saveConversationReference } from './lib/conversation-store.js';

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

// Bot Framework authentication configuration
const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({}, {
  MicrosoftAppId: credentials.appId,
  MicrosoftAppPassword: credentials.appPassword,
  MicrosoftAppTenantId: credentials.tenantId || '',
  MicrosoftAppType: credentials.tenantId ? 'SingleTenant' : 'MultiTenant',
});

const adapter = new CloudAdapter(botFrameworkAuth);

adapter.onTurnError = async (context, error) => {
  console.error(`[teams] Adapter error: ${error.message}`);
  try {
    await context.sendActivity('Sorry, something went wrong processing your message.');
  } catch (sendErr) {
    console.error(`[teams] Failed to send error response: ${sendErr.message}`);
  }
};

// Bot identity
let botName = 'bot';
let botId = credentials.appId || '';

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
function formatMessage(type, userName, text, { groupName } = {}) {
  const prefix = type === 'dm'
    ? '[Teams DM]'
    : `[Teams GROUP:${escapeXml(groupName || 'unknown')}]`;
  const safeUserName = escapeXml(userName);
  const safeText = escapeXml(text);
  return `${prefix} ${safeUserName} said: <current-message>\n${safeText}\n</current-message>`;
}

/**
 * Handle incoming message activity.
 */
async function handleMessage(context) {
  const activity = context.activity;
  if (!activity || activity.type !== ActivityTypes.Message) return;

  const activityId = activity.id;
  if (isDuplicate(activityId)) return;

  // Save conversation reference for proactive messaging
  const conversationRef = TurnContext.getConversationReference(activity);
  const conversationId = activity.conversation?.id;
  if (conversationId && conversationRef) {
    saveConversationReference(conversationId, conversationRef);
  }

  const senderAadObjectId = activity.from?.aadObjectId || '';
  const senderName = activity.from?.name || 'unknown';
  const convType = getConversationType(activity);
  const text = activity.text || '';

  console.log(`[teams] ${convType} message from ${senderName} (${senderAadObjectId}): ${text.substring(0, 50)}...`);

  const endpoint = buildEndpoint(conversationId, {
    type: convType,
    aadObjectId: senderAadObjectId,
    activityId
  });

  const rejectReply = async (errMsg) => {
    try {
      await context.sendActivity(errMsg);
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
      await context.sendActivity("Sorry, I'm not available for private messages. Please ask my owner to grant you access.");
      return;
    }

    const msg = formatMessage('dm', senderName, text);
    sendToC4('teams', endpoint, msg, (errMsg) => rejectReply(errMsg));
    return;
  }

  // Group / channel handling
  if (convType === 'group' || convType === 'channel') {
    const senderIsOwner = isOwner(senderAadObjectId);
    const groupPolicy = config.groupPolicy || 'allowlist';
    const mentioned = isBotMentioned(activity);

    if (groupPolicy === 'disabled') {
      console.log(`[teams] Group policy disabled, ignoring message from ${senderAadObjectId}`);
      return;
    }

    const allowedGroup = isGroupAllowed(conversationId);

    if (!allowedGroup && !senderIsOwner) {
      if (mentioned) {
        console.log(`[teams] Group ${conversationId} not allowed, rejecting`);
        await context.sendActivity("Sorry, I'm not available in this group.");
      }
      return;
    }

    // In groups/channels, only respond to @mentions (or owner messages in allowed groups)
    if (!mentioned && !senderIsOwner) {
      console.log(`[teams] Group message without @mention, ignoring`);
      return;
    }

    if (!mentioned && senderIsOwner && !allowedGroup) {
      // Owner in non-allowed group without mention: process as owner override
    }

    const cleanText = stripBotMention(activity);
    const groupName = getGroupName(conversationId);
    const msg = formatMessage(convType, senderName, cleanText, { groupName });
    sendToC4('teams', endpoint, msg, (errMsg) => rejectReply(errMsg));
    return;
  }
}

// Express app
const app = express();
app.use(express.json());

// Bot Framework messaging endpoint
app.post('/api/messages', async (req, res) => {
  try {
    await adapter.process(req, res, async (context) => {
      if (context.activity.type === ActivityTypes.Message) {
        await handleMessage(context);
      } else if (context.activity.type === ActivityTypes.ConversationUpdate) {
        // Handle member added events (bot installed in chat)
        const membersAdded = context.activity.membersAdded || [];
        for (const member of membersAdded) {
          if (member.id === context.activity.recipient?.id) {
            console.log(`[teams] Bot added to conversation: ${context.activity.conversation?.id}`);
            const ref = TurnContext.getConversationReference(context.activity);
            if (context.activity.conversation?.id) {
              saveConversationReference(context.activity.conversation.id, ref);
            }
          }
        }
      }
    });
  } catch (err) {
    console.error(`[teams] Error processing request: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Health check
app.get('/health', (req, res) => {
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

// Internal endpoint for send.js to send messages via the adapter
app.post('/internal/send', async (req, res) => {
  const token = req.headers['x-internal-token'];
  if (!token || token !== INTERNAL_TOKEN) {
    return res.status(403).json({ error: 'unauthorized' });
  }

  const { conversationId, text, type } = req.body || {};
  if (!conversationId || !text) {
    return res.status(400).json({ error: 'missing conversationId or text' });
  }

  try {
    const { getConversationReference: getRef } = await import('./lib/conversation-store.js');
    const reference = getRef(conversationId);
    if (!reference) {
      return res.status(404).json({ error: 'no conversation reference found' });
    }

    await adapter.continueConversationAsync(
      credentials.appId,
      reference,
      async (context) => {
        await context.sendActivity(text);
      }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(`[teams] Internal send error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

let server = null;
let isShuttingDown = false;

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[teams] Shutting down...');
  clearInterval(dedupCleanupInterval);
  stopWatching();

  const finishExit = () => process.exit(0);
  if (!server) return finishExit();
  server.close(() => finishExit());
  setTimeout(finishExit, 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const PORT = config.port || 3978;
const MAX_LISTEN_RETRIES = 5;

async function startServerWithRetry(port, maxRetries = MAX_LISTEN_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const started = await new Promise((resolve, reject) => {
        const srv = app.listen(port, '127.0.0.1', () => {
          srv.off('error', onError);
          resolve(srv);
        });
        const onError = (err) => {
          srv.off('error', onError);
          reject(err);
        };
        srv.once('error', onError);
      });
      return started;
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
  server = await startServerWithRetry(PORT);
  server.on('error', (err) => {
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
