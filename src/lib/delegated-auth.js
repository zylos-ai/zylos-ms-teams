import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getCredentials, DATA_DIR } from './config.js';
import { writeJsonAtomic } from './atomic-write.js';
import { extractChannelIds } from './format.js';

const TOKENS_FILE = path.join(DATA_DIR, 'delegated-tokens.json');
const AUTH_URL_TEMPLATE = 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize';
const TOKEN_URL_TEMPLATE = 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token';
const DELEGATED_SCOPES = 'Chat.ReadWrite ChannelMessage.Send offline_access';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

let tokens = {};
let tokensMtimeMs = 0;

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const stat = fs.statSync(TOKENS_FILE);
      if (stat.mtimeMs === tokensMtimeMs) return;
      tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
      tokensMtimeMs = stat.mtimeMs;
    }
  } catch { tokens = {}; }
}

function saveTokens() {
  try {
    writeJsonAtomic(TOKENS_FILE, tokens, 0o600);
    try { tokensMtimeMs = fs.statSync(TOKENS_FILE).mtimeMs; } catch {}
  } catch (err) {
    console.error(`[ms-teams/delegated-auth] Failed to save tokens: ${err.message}`);
  }
}

loadTokens();

const pendingStates = new Map();

const stateCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [state, info] of pendingStates) {
    if (info.timestamp < cutoff) pendingStates.delete(state);
  }
}, 5 * 60_000);
stateCleanupTimer.unref();

export function buildAuthUrl(redirectUri) {
  const creds = getCredentials();
  if (!creds.tenantId) throw new Error('MSTEAMS_TENANT_ID required');

  const state = crypto.randomBytes(16).toString('hex');
  const url = AUTH_URL_TEMPLATE.replace('{tenantId}', creds.tenantId);
  const params = new URLSearchParams({
    client_id: creds.appId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: DELEGATED_SCOPES,
    state,
    response_mode: 'query',
    prompt: 'consent',
  });

  pendingStates.set(state, { redirectUri, timestamp: Date.now() });
  return { url: `${url}?${params}`, state };
}

export function consumeState(state) {
  const data = pendingStates.get(state);
  if (!data) return null;
  pendingStates.delete(state);
  return data;
}

export async function exchangeCode(code, redirectUri) {
  const creds = getCredentials();
  const url = TOKEN_URL_TEMPLATE.replace('{tenantId}', creds.tenantId);

  const body = new URLSearchParams({
    client_id: creds.appId,
    client_secret: creds.appPassword,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    scope: DELEGATED_SCOPES,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const payload = JSON.parse(
    Buffer.from(data.access_token.split('.')[1], 'base64url').toString()
  );
  const aadObjectId = payload.oid || payload.sub;
  const displayName = payload.name || 'unknown';

  tokens[aadObjectId] = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
    displayName,
  };
  saveTokens();

  console.log(`[ms-teams/delegated-auth] Authorized: ${displayName} (${aadObjectId})`);
  return { aadObjectId, displayName };
}

async function refreshToken(aadObjectId) {
  const entry = tokens[aadObjectId];
  if (!entry?.refreshToken) return null;

  const creds = getCredentials();
  const url = TOKEN_URL_TEMPLATE.replace('{tenantId}', creds.tenantId);
  const body = new URLSearchParams({
    client_id: creds.appId,
    client_secret: creds.appPassword,
    refresh_token: entry.refreshToken,
    grant_type: 'refresh_token',
    scope: DELEGATED_SCOPES,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    console.warn(`[ms-teams/delegated-auth] Refresh failed for ${aadObjectId}, revoking`);
    delete tokens[aadObjectId];
    saveTokens();
    return null;
  }

  const data = await res.json();
  tokens[aadObjectId] = {
    ...entry,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || entry.refreshToken,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };
  saveTokens();
  return data.access_token;
}

export async function getDelegatedToken(aadObjectId) {
  loadTokens();
  const entry = tokens[aadObjectId];
  if (!entry) return null;

  if (Date.now() < entry.expiresAt - 60_000) {
    return entry.accessToken;
  }

  return refreshToken(aadObjectId);
}

export function hasAuth(aadObjectId) {
  loadTokens();
  return !!tokens[aadObjectId];
}

export function getAuthenticatedUsers() {
  loadTokens();
  return Object.entries(tokens).map(([id, t]) => ({
    aadObjectId: id,
    displayName: t.displayName,
    expiresAt: t.expiresAt,
  }));
}

export function revokeAuth(aadObjectId) {
  loadTokens();
  if (!tokens[aadObjectId]) return false;
  delete tokens[aadObjectId];
  saveTokens();
  return true;
}

// ── Graph Chat ID Resolution ──

function resolveGraphChatId(aadObjectId) {
  const creds = getCredentials();
  if (!creds.appId) return null;
  return `19:${aadObjectId}_${creds.appId}@unq.gbl.spaces`;
}

// ── Reaction Type Mapping ──
// Graph chat API requires emoji characters; channel API accepts string names.

const REACTION_EMOJI = {
  like: '\u{1F44D}',
  heart: '\u{2764}\u{FE0F}',
  laugh: '\u{1F606}',
  surprised: '\u{1F62E}',
  sad: '\u{1F622}',
  angry: '\u{1F621}',
};

function toReactionType(reactionType, conversationType) {
  if (conversationType === 'channel') return reactionType;
  return REACTION_EMOJI[reactionType] || reactionType;
}

// ── Reaction API ──

async function resolveReactionUrl(aadObjectId, conversationType, conversationId, messageId, action, activity) {
  const verb = action === 'remove' ? 'unsetReaction' : 'setReaction';

  if (conversationType === 'channel') {
    const { teamId, channelId } = extractChannelIds(activity?.channelData);
    if (!teamId || !channelId) throw new Error('Missing teamId or channelId for channel reaction');
    return `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/${verb}`;
  }

  let graphChatId;
  if (conversationType === 'group') {
    graphChatId = conversationId;
  } else {
    graphChatId = resolveGraphChatId(aadObjectId);
    if (!graphChatId) return null;
  }
  return `${GRAPH_BASE}/chats/${encodeURIComponent(graphChatId)}/messages/${encodeURIComponent(messageId)}/${verb}`;
}

export async function sendReaction({ aadObjectId, conversationType, conversationId, messageId, reactionType, activity }) {
  const token = await getDelegatedToken(aadObjectId);
  if (!token) throw new Error(`No delegated auth for user ${aadObjectId}`);

  const url = await resolveReactionUrl(aadObjectId, conversationType, conversationId, messageId, 'set', activity);
  if (!url) {
    console.debug(`[ms-teams/delegated-auth] DM reaction skipped: could not resolve chat ID for ${conversationId}`);
    return;
  }

  if (conversationType === 'channel') {
    const { teamId, channelId } = extractChannelIds(activity?.channelData);
    console.debug(`[ms-teams/delegated-auth] Channel reaction: teamId=${teamId}, channelId=${channelId}, msgId=${messageId}`);
  }

  const mappedType = toReactionType(reactionType, conversationType);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reactionType: mappedType }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`setReaction failed (${res.status}): ${text}`);
  }
  console.log(`[ms-teams/delegated-auth] Reaction '${reactionType}' set on ${messageId}`);
}

export async function removeReaction({ aadObjectId, conversationType, conversationId, messageId, reactionType, activity }) {
  const token = await getDelegatedToken(aadObjectId);
  if (!token) throw new Error(`No delegated auth for user ${aadObjectId}`);

  const url = await resolveReactionUrl(aadObjectId, conversationType, conversationId, messageId, 'remove', activity);
  if (!url) {
    console.debug(`[ms-teams/delegated-auth] DM reaction removal skipped: could not resolve chat ID for ${conversationId}`);
    return;
  }

  const mappedType = toReactionType(reactionType, conversationType);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reactionType: mappedType }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`unsetReaction failed (${res.status}): ${text}`);
  }
  console.log(`[ms-teams/delegated-auth] Reaction '${reactionType}' removed from ${messageId}`);
}

function _setTokensForTest(data) { tokens = data; }

export { resolveGraphChatId as _resolveGraphChatId, _setTokensForTest };
