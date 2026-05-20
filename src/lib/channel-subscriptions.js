import fs from 'node:fs';
import path from 'node:path';
import { getCredentials, DATA_DIR } from './config.js';
import { acquireTokenForScope, graphRequest } from './graph.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const SUBS_FILE = path.join(DATA_DIR, 'channel-subscriptions.json');
const RENEWAL_MARGIN_MS = 5 * 60_000;
const MAX_LIFETIME_MIN = 55;

let renewalTimer = null;

function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveSubscriptions(subs) {
  const tmp = SUBS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(subs, null, 2));
  fs.renameSync(tmp, SUBS_FILE);
}


function buildResource(teamId, channelId) {
  return `/teams/${teamId}/channels/${channelId}/messages`;
}

function expirationDateTime() {
  return new Date(Date.now() + MAX_LIFETIME_MIN * 60_000).toISOString();
}

export async function createSubscription(teamId, channelId, notificationUrl) {
  const resource = buildResource(teamId, channelId);
  const body = {
    changeType: 'created',
    notificationUrl,
    resource,
    expirationDateTime: expirationDateTime(),
    clientState: getCredentials().tenantId,
  };

  console.log(`[ms-teams/subs] Creating subscription for ${resource}`);
  const sub = await graphRequest('/subscriptions', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const subs = loadSubscriptions();
  subs[channelId] = {
    id: sub.id,
    teamId,
    channelId,
    resource,
    expirationDateTime: sub.expirationDateTime,
  };
  saveSubscriptions(subs);
  console.log(`[ms-teams/subs] Subscription created: ${sub.id}, expires ${sub.expirationDateTime}`);
  return sub;
}

export async function renewSubscription(subId) {
  const body = { expirationDateTime: expirationDateTime() };
  console.log(`[ms-teams/subs] Renewing subscription ${subId}`);
  const sub = await graphRequest(`/subscriptions/${subId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  const subs = loadSubscriptions();
  for (const entry of Object.values(subs)) {
    if (entry.id === subId) {
      entry.expirationDateTime = sub.expirationDateTime;
      break;
    }
  }
  saveSubscriptions(subs);
  console.log(`[ms-teams/subs] Subscription renewed, expires ${sub.expirationDateTime}`);
  return sub;
}

export async function deleteSubscription(subId) {
  try {
    const token = await acquireTokenForScope(GRAPH_SCOPE);
    await fetch(`${GRAPH_BASE}/subscriptions/${subId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`[ms-teams/subs] Subscription deleted: ${subId}`);
  } catch (err) {
    console.warn(`[ms-teams/subs] Failed to delete subscription ${subId}: ${err.message}`);
  }
  const subs = loadSubscriptions();
  for (const [key, entry] of Object.entries(subs)) {
    if (entry.id === subId) {
      delete subs[key];
      break;
    }
  }
  saveSubscriptions(subs);
}

export async function fetchMessage(teamId, channelId, messageId) {
  const path = `/teams/${teamId}/channels/${channelId}/messages/${messageId}`;
  return graphRequest(path);
}

export async function fetchReplyMessage(teamId, channelId, rootMessageId, replyId) {
  const path = `/teams/${teamId}/channels/${channelId}/messages/${rootMessageId}/replies/${replyId}`;
  return graphRequest(path);
}

export async function syncSubscriptions(channels, notificationUrl) {
  const subs = loadSubscriptions();
  const smartChannels = Object.entries(channels)
    .filter(([, cfg]) => cfg.mode === 'smart' && cfg.teamId);

  // Remove subscriptions for channels no longer in smart mode
  for (const [chId, entry] of Object.entries(subs)) {
    const channelCfg = channels[chId];
    if (!channelCfg || channelCfg.mode !== 'smart') {
      await deleteSubscription(entry.id);
    }
  }

  // Create subscriptions for smart channels that don't have one
  for (const [chId, cfg] of smartChannels) {
    if (!subs[chId]) {
      try {
        await createSubscription(cfg.teamId, chId, notificationUrl);
      } catch (err) {
        console.error(`[ms-teams/subs] Failed to create subscription for ${chId}: ${err.message}`);
      }
    }
  }
}

export async function renewAllSubscriptions() {
  const subs = loadSubscriptions();
  const now = Date.now();

  for (const [chId, entry] of Object.entries(subs)) {
    const expiresAt = new Date(entry.expirationDateTime).getTime();
    if (expiresAt - now < RENEWAL_MARGIN_MS) {
      try {
        await renewSubscription(entry.id);
      } catch (err) {
        console.warn(`[ms-teams/subs] Renewal failed for ${chId}, recreating: ${err.message}`);
        try {
          await deleteSubscription(entry.id);
        } catch {}
      }
    }
  }
}

export function startRenewalLoop() {
  if (renewalTimer) clearInterval(renewalTimer);
  renewalTimer = setInterval(async () => {
    try {
      await renewAllSubscriptions();
    } catch (err) {
      console.error(`[ms-teams/subs] Renewal loop error: ${err.message}`);
    }
  }, 10 * 60_000);
  renewalTimer.unref();
}

export function stopRenewalLoop() {
  if (renewalTimer) {
    clearInterval(renewalTimer);
    renewalTimer = null;
  }
}

export function getActiveSubscriptions() {
  return loadSubscriptions();
}
