import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getCredentials, DATA_DIR } from './config.js';

const TOKENS_FILE = path.join(DATA_DIR, 'delegated-tokens.json');
const AUTH_URL_TEMPLATE = 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize';
const TOKEN_URL_TEMPLATE = 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token';
const DELEGATED_SCOPES = 'Chat.ReadWrite ChannelMessage.Send offline_access';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

let tokens = {};

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    }
  } catch { tokens = {}; }
}

function saveTokens() {
  try {
    fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error(`[teams/delegated-auth] Failed to save tokens: ${err.message}`);
  }
}

loadTokens();

const pendingStates = new Map();

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [state, info] of pendingStates) {
    if (info.timestamp < cutoff) pendingStates.delete(state);
  }
}, 5 * 60_000);

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

export function validateState(state) {
  return pendingStates.has(state);
}

export async function exchangeCode(code, state, redirectUri) {
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
  pendingStates.delete(state);

  console.log(`[teams/delegated-auth] Authorized: ${displayName} (${aadObjectId})`);
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
  });

  if (!res.ok) {
    console.warn(`[teams/delegated-auth] Refresh failed for ${aadObjectId}, revoking`);
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

// ── Reaction API ──

export async function sendReaction({ aadObjectId, conversationType, conversationId, messageId, reactionType, activity }) {
  const token = await getDelegatedToken(aadObjectId);
  if (!token) throw new Error(`No delegated auth for user ${aadObjectId}`);

  let url;
  if (conversationType === 'channel') {
    const channelData = activity?.channelData || {};
    const teamId = channelData.team?.id || channelData.teamId;
    const channelId = channelData.channel?.id || channelData.channelId || channelData.teamsChannelId;
    if (!teamId || !channelId) throw new Error('Missing teamId or channelId for channel reaction');
    url = `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/setReaction`;
  } else {
    url = `${GRAPH_BASE}/chats/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/setReaction`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reactionType }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`setReaction failed (${res.status}): ${text}`);
  }
  console.log(`[teams/delegated-auth] Reaction '${reactionType}' set on ${messageId}`);
}

export async function removeReaction({ aadObjectId, conversationType, conversationId, messageId, reactionType, activity }) {
  const token = await getDelegatedToken(aadObjectId);
  if (!token) throw new Error(`No delegated auth for user ${aadObjectId}`);

  let url;
  if (conversationType === 'channel') {
    const channelData = activity?.channelData || {};
    const teamId = channelData.team?.id || channelData.teamId;
    const channelId = channelData.channel?.id || channelData.channelId || channelData.teamsChannelId;
    if (!teamId || !channelId) throw new Error('Missing teamId or channelId for channel reaction');
    url = `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/unsetReaction`;
  } else {
    url = `${GRAPH_BASE}/chats/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/unsetReaction`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reactionType }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`unsetReaction failed (${res.status}): ${text}`);
  }
  console.log(`[teams/delegated-auth] Reaction '${reactionType}' removed from ${messageId}`);
}
