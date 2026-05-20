import fs from 'node:fs';
import path from 'node:path';
import { getCredentials, DATA_DIR } from './config.js';
import { htmlToText } from './html.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL_TEMPLATE = 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const BOT_SCOPE = 'https://api.botframework.com/.default';

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

  const now = Date.now();
  const cached = tokenCache.get(scope);
  if (cached && now < cached.expiresAt - 60_000) {
    return cached.token;
  }

  const url = TOKEN_URL_TEMPLATE.replace('{tenantId}', creds.tenantId);
  const body = new URLSearchParams({
    client_id: creds.appId,
    client_secret: creds.appPassword,
    scope,
    grant_type: 'client_credentials',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  tokenCache.set(scope, {
    token: data.access_token,
    expiresAt: now + (data.expires_in * 1000),
  });
  return data.access_token;
}

function acquireToken() {
  return acquireTokenForScope(GRAPH_SCOPE);
}

function acquireBotToken() {
  return acquireTokenForScope(BOT_SCOPE);
}

export async function graphRequest(urlPath, options = {}) {
  const token = await acquireToken();
  const url = urlPath.startsWith('http') ? urlPath : `${GRAPH_BASE}${urlPath}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph API error (${res.status}): ${text}`);
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
    const url = `${GRAPH_BASE}${urlPath}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${delegatedToken}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph API error (${res.status}): ${text}`);
    }
    data = await res.json();
  } else {
    data = await graphRequest(urlPath);
  }

  const messages = (data.value || []).reverse();
  console.debug(`[ms-teams/graph] fetchChannelHistory: path=${urlPath}, token=${delegatedToken ? 'delegated' : 'app'}, returned ${messages.length} messages`);
  return messages.map(formatGraphMessage);
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


/**
 * Download hosted content (images/files) from a Teams message.
 * Returns the local file path, or null on failure.
 */
export async function downloadHostedContent(contentUrl, filename) {
  if (!isGraphEnabled()) return null;

  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });

    // Bot Framework service URLs need a bot-scoped token, not Graph
    const isGraphUrl = contentUrl.includes('graph.microsoft.com');
    const token = isGraphUrl ? await acquireToken() : await acquireBotToken();

    const res = await fetch(contentUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: '*/*',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Download error (${res.status}): ${text}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(MEDIA_DIR, `${Date.now()}_${safeName}`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err) {
    console.error(`[ms-teams/graph] Failed to download hosted content: ${err.message}`);
    return null;
  }
}

/**
 * Fetch members of a team.
 */
export async function fetchTeamMembers(teamId) {
  if (!isGraphEnabled()) return [];

  const encoded = encodeURIComponent(teamId);
  const data = await graphRequest(`/teams/${encoded}/members`);
  return (data.value || []).map(m => ({
    displayName: m.displayName || 'unknown',
    userId: m.userId || '',
    email: m.email || '',
    roles: m.roles || [],
  }));
}

