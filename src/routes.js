import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { getConfig, getCredentials } from './lib/config.js';
import { getConversationReference } from './lib/conversation-store.js';
import { isGraphEnabled, acquireTokenForScope } from './lib/graph.js';
import { buildAuthUrl, validateState, exchangeCode, getDelegatedToken, hasAuth, sendReaction, removeReaction } from './lib/delegated-auth.js';
import { validateClientState } from './lib/channel-subscriptions.js';

function sanitizePrefix(raw) {
  if (!raw) return '';
  const prefix = raw.replace(/\/$/, '');
  if (!prefix) return '';
  if (!prefix.startsWith('/')) return '';
  if (/\/\/|[?#%\\]|\.\.|\p{Cc}|\s|[<>"'`&]/u.test(prefix)) return '';
  return prefix;
}

export function buildRedirectUri(req) {
  const publicUrl = process.env.MSTEAMS_PUBLIC_URL;
  if (publicUrl) {
    try {
      const parsed = new URL(publicUrl);
      if (parsed.protocol !== 'https:') {
        console.warn('[ms-teams/auth] MSTEAMS_PUBLIC_URL is not HTTPS, falling back to headers');
      } else {
        const base = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
        return `${base}/auth/callback`;
      }
    } catch {}
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  const prefix = sanitizePrefix(req.headers['x-forwarded-prefix']);
  return `${protocol}://${host}${prefix}/auth/callback`;
}

/**
 * Register all HTTP routes on the Express app.
 *
 * @param {object} expressApp - Express application
 * @param {object} deps - Shared dependencies
 * @param {string} deps.internalToken - Token for internal endpoint auth
 * @param {object} deps.teamsApp - Teams SDK app instance
 * @param {string} deps.botName - Bot display name
 * @param {Map} deps.reactionContextCache
 * @param {Map} deps.pendingReactions
 * @param {Function} deps.persistReactionCache
 * @param {Function} deps.recordHistoryEntry
 * @param {Function} deps.handleChannelNotification
 * @param {Function} deps.stopTyping
 */
export function registerRoutes(expressApp, deps) {
  const {
    internalToken,
    teamsApp,
    botName,
    reactionContextCache,
    pendingReactions,
    persistReactionCache,
    recordHistoryEntry,
    handleChannelNotification,
    stopTyping,
  } = deps;

  // ── Internal send endpoint ──

  expressApp.use('/internal/send', express.json());
  expressApp.post('/internal/send', async (req, res) => {
    const token = req.headers['x-internal-token'];
    if (!token || token !== internalToken) {
      return res.status(403).json({ error: 'unauthorized' });
    }

    const { conversationId, text, type, replyToId } = req.body || {};
    if (!conversationId || !text) {
      return res.status(400).json({ error: 'missing conversationId or text' });
    }

    stopTyping(conversationId);

    try {
      const baseConvId = conversationId.split(';')[0];
      const reference = await getConversationReference(baseConvId) || await getConversationReference(conversationId);
      if (!reference) {
        return res.status(404).json({ error: 'no conversation reference found' });
      }

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
          signal: AbortSignal.timeout(30_000),
        });
        if (!apiRes.ok) {
          const errText = await apiRes.text();
          throw new Error(`Bot Connector API failed (${apiRes.status}): ${errText}`);
        }
      } else {
        const activity = { type: 'message', text, textFormat: 'markdown' };
        await teamsApp.send(baseConvId, activity);
      }

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

  // ── Internal stream endpoint (progressive message updates) ──

  const activeStreams = new Map();

  expressApp.use('/internal/stream', express.json());
  expressApp.post('/internal/stream', async (req, res) => {
    const token = req.headers['x-internal-token'];
    if (!token || token !== internalToken) {
      return res.status(403).json({ error: 'unauthorized' });
    }

    const { action, conversationId, text, type, replyToId, streamId } = req.body || {};

    if (action === 'start') {
      if (!conversationId || !text) {
        return res.status(400).json({ error: 'missing conversationId or text' });
      }

      stopTyping(conversationId);

      try {
        const baseConvId = conversationId.split(';')[0];
        const reference = await getConversationReference(baseConvId) || await getConversationReference(conversationId);
        if (!reference) {
          return res.status(404).json({ error: 'no conversation reference found' });
        }

        const botToken = await acquireTokenForScope('https://api.botframework.com/.default');
        const serviceUrl = (reference.serviceUrl || '').replace(/\/$/, '');
        const activity = {
          type: 'message',
          text,
          textFormat: 'markdown',
          conversation: { id: type === 'channel' ? conversationId : baseConvId },
        };
        if (type === 'channel' && replyToId) activity.replyToId = replyToId;

        const targetConvId = type === 'channel' ? conversationId : baseConvId;
        const apiUrl = `${serviceUrl}/v3/conversations/${encodeURIComponent(targetConvId)}/activities`;
        const apiRes = await fetch(apiUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(activity),
          signal: AbortSignal.timeout(30_000),
        });
        if (!apiRes.ok) {
          const errText = await apiRes.text();
          throw new Error(`Bot Connector API failed (${apiRes.status}): ${errText}`);
        }
        const result = await apiRes.json();
        const activityId = result.id;
        const sid = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        activeStreams.set(sid, { conversationId: targetConvId, activityId, serviceUrl, botToken, type });
        setTimeout(() => activeStreams.delete(sid), 5 * 60_000);

        res.json({ ok: true, streamId: sid, activityId });
      } catch (err) {
        console.error(`[ms-teams] Stream start error: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
      return;
    }

    if (action === 'update' || action === 'end') {
      if (!streamId) {
        return res.status(400).json({ error: 'missing streamId' });
      }
      const stream = activeStreams.get(streamId);
      if (!stream) {
        return res.status(404).json({ error: 'stream not found or expired' });
      }

      try {
        if (text) {
          const updateActivity = {
            type: 'message',
            text,
            textFormat: 'markdown',
            conversation: { id: stream.conversationId },
          };
          const updateUrl = `${stream.serviceUrl}/v3/conversations/${encodeURIComponent(stream.conversationId)}/activities/${encodeURIComponent(stream.activityId)}`;
          const apiRes = await fetch(updateUrl, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${stream.botToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(updateActivity),
            signal: AbortSignal.timeout(30_000),
          });
          if (!apiRes.ok) {
            const errText = await apiRes.text();
            throw new Error(`Activity update failed (${apiRes.status}): ${errText}`);
          }
        }

        if (action === 'end') {
          const baseConvId = stream.conversationId.split(';')[0];
          recordHistoryEntry(baseConvId, {
            timestamp: new Date().toISOString(),
            message_id: stream.activityId,
            user_id: 'bot',
            user_name: botName,
            text: (text || '').substring(0, 500),
          });
          activeStreams.delete(streamId);
        }

        res.json({ ok: true });
      } catch (err) {
        console.error(`[ms-teams] Stream ${action} error: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
      return;
    }

    res.status(400).json({ error: 'invalid action — use start, update, or end' });
  });

  // ── Internal media send endpoint ──

  expressApp.use('/internal/send-media', express.json());
  expressApp.post('/internal/send-media', async (req, res) => {
    const token = req.headers['x-internal-token'];
    if (!token || token !== internalToken) {
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

      const reference = await getConversationReference(conversationId);
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
    const credentials = getCredentials();
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

    const redirectUri = buildRedirectUri(req);

    try {
      const { aadObjectId, displayName } = await exchangeCode(code, state, redirectUri);
      res.send(`<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Signed in successfully</h2><p>${displayName}, your delegated auth is now active.</p><p>You can close this tab and return to Teams.</p></body></html>`);
    } catch (err) {
      console.error(`[ms-teams/auth] Token exchange failed: ${err.message}`);
      res.status(500).send('Authentication failed. Please try again.');
    }
  });

  expressApp.get('/auth/sign-in', (req, res) => {
    const redirectUri = buildRedirectUri(req);

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
    if (!token || token !== internalToken) {
      return res.status(403).json({ error: 'unauthorized' });
    }

    const config = getConfig();
    const { conversationId, messageId, reactionType, aadObjectId, conversationType, teamId, channelId, action } = req.body || {};

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
    if (req.query.validationToken) {
      console.log('[ms-teams/subs] Validation handshake received');
      res.set('Content-Type', 'text/plain');
      return res.status(200).send(req.query.validationToken);
    }

    res.status(202).send();

    const notifications = req.body?.value || [];
    for (const notification of notifications) {
      if (!validateClientState(notification.clientState)) {
        console.warn(`[ms-teams/subs] Notification rejected: invalid clientState`);
        continue;
      }
      try {
        await handleChannelNotification(notification);
      } catch (err) {
        console.error(`[ms-teams/subs] Notification error: ${err.message}`);
      }
    }
  });
}
