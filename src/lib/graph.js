import path from 'node:path';
import { getConfig, getCredentials, DATA_DIR } from './config.js';
import { htmlToText } from './html.js';
import { buildGraphUrl, buildLoginUrl, getCloudConfig } from './cloud.js';
import { appendErrorHint } from './errors.js';

export const MEDIA_DIR = path.join(DATA_DIR, 'media');

// Per-scope token cache: { token, expiresAt }
const tokenCache = new Map();

export function isGraphEnabled() {
  const creds = getCredentials();
  return !!(creds.appId && creds.appPassword && creds.tenantId);
}

export async function acquireTokenForScope(scope) {
  const creds = getCredentials();
  if (!creds.tenantId) throw new Error('MSTEAMS_TENANT_ID required for token acquisition');
  const cloudName = getConfig().cloud || 'public';
  const cloud = getCloudConfig(cloudName);
  const resolvedScope = scope === 'botframework'
    ? cloud.botFrameworkScope
    : scope === 'graph'
      ? cloud.graphScope
      : scope;

  const now = Date.now();
  const cacheKey = `${cloud.name}:${resolvedScope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && now < cached.expiresAt - 60_000) {
    return cached.token;
  }

  const url = buildLoginUrl(creds.tenantId, cloudName);
  const body = new URLSearchParams({
    client_id: creds.appId,
    client_secret: creds.appPassword,
    scope: resolvedScope,
    grant_type: 'client_credentials',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(appendErrorHint(`Token request failed (${res.status}): ${text}`, {
      status: res.status,
      headers: res.headers,
    }));
  }

  const data = await res.json();
  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: now + (data.expires_in * 1000),
  });
  return data.access_token;
}

function acquireToken() {
  return acquireTokenForScope('graph');
}

function acquireBotToken() {
  return acquireTokenForScope('botframework');
}

export async function graphRequest(urlPath, options = {}) {
  const token = await acquireToken();
  const url = buildGraphUrl(urlPath, getConfig().cloud);

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: options.signal || AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(appendErrorHint(`Graph API error (${res.status}): ${text}`, {
      status: res.status,
      headers: res.headers,
    }));
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res;
}

/**
 * Convert a Bot Framework conversation ID to a Graph chat ID.
 * BF format: 19:xxx@thread.v2  or  19:xxx@unq.gbl.spaces
 * Graph format: the same ID works for /chats/{id}
 */
function toGraphChatId(conversationId) {
  return conversationId;
}

/**
 * Fetch recent messages from a chat (DM or group chat).
 * Returns messages in chronological order (oldest first).
 */
export async function fetchChatHistory(conversationId, count = 10) {
  if (!isGraphEnabled()) return [];

  const chatId = toGraphChatId(conversationId);
  const encoded = encodeURIComponent(chatId);

  const data = await graphRequest(
    `/chats/${encoded}/messages?$top=${count}&$orderby=createdDateTime desc`
  );

  const messages = (data.value || []).reverse();
  return messages.map(formatGraphMessage);
}

/**
 * Fetch recent messages from a Teams channel.
 */
export async function fetchChannelHistory(teamId, channelId, count = 10, threadMessageId = '', delegatedToken = '') {
  if (!isGraphEnabled()) return [];

  const encodedTeam = encodeURIComponent(teamId);
  const encodedChannel = encodeURIComponent(channelId);

  let urlPath;
  if (threadMessageId) {
    urlPath = `/teams/${encodedTeam}/channels/${encodedChannel}/messages/${encodeURIComponent(threadMessageId)}/replies?$top=${count}`;
  } else {
    urlPath = `/teams/${encodedTeam}/channels/${encodedChannel}/messages?$top=${count}`;
  }

  let data;
  if (delegatedToken) {
    const url = buildGraphUrl(urlPath, getConfig().cloud);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${delegatedToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(appendErrorHint(`Graph API error (${res.status}): ${text}`, {
        status: res.status,
        headers: res.headers,
      }));
    }
    data = await res.json();
  } else {
    data = await graphRequest(urlPath);
  }

  const messages = (data.value || []).reverse();
  console.debug(`[ms-teams/graph] fetchChannelHistory: path=${urlPath}, token=${delegatedToken ? 'delegated' : 'app'}, returned ${messages.length} messages`);
  return messages.map(formatGraphMessage);
}

export async function getThreadMessages(conversationId, replyToId, limit = 5, {
  teamId = '',
  channelId = '',
  delegatedToken = '',
} = {}) {
  if (!isGraphEnabled()) return [];
  const baseConversationId = String(conversationId || '').split(';')[0];
  const threadRootId = replyToId || String(conversationId || '').match(/;messageid=([^;]+)/)?.[1] || '';
  const resolvedChannelId = channelId || baseConversationId;
  const resolvedTeamId = teamId || getConfig().channels?.[resolvedChannelId]?.teamId || '';
  if (!threadRootId || !resolvedTeamId || !resolvedChannelId) return [];
  return fetchChannelHistory(resolvedTeamId, resolvedChannelId, limit, threadRootId, delegatedToken);
}

function formatGraphMessage(msg) {
  const from = msg.from?.user?.displayName
    || msg.from?.application?.displayName
    || 'unknown';
  const body = msg.body?.contentType === 'html'
    ? htmlToText(msg.body.content || '')
    : (msg.body?.content || '');
  const time = msg.createdDateTime || '';
  const id = msg.id || '';
  const attachments = (msg.attachments || []).map(a => a.name || a.contentType).filter(Boolean);

  return { from, body, time, id, attachments };
}
