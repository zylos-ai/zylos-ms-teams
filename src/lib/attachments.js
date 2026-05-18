import fs from 'node:fs';
import path from 'node:path';
import { acquireTokenForScope, MEDIA_DIR, isGraphEnabled } from './graph.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

const ATTACHMENT_TAG_RE = /<attachment[^>]+id=["']([^"']+)["'][^>]*>/gi;
const IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["'][^>]*/gi;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp|svg|ico|tiff?)$/i;

const DEFAULT_MEDIA_ALLOW_HOSTS = [
  'graph.microsoft.com', 'graph.microsoft.us', 'graph.microsoft.de', 'graph.microsoft.cn',
  'sharepoint.com', 'sharepoint.us', 'sharepoint.de', 'sharepoint.cn', 'sharepoint-df.com',
  '1drv.ms', 'onedrive.com', 'teams.microsoft.com', 'teams.cdn.office.net',
  'statics.teams.cdn.office.net', 'office.com', 'office.net',
  'asm.skype.com', 'ams.skype.com', 'media.ams.skype.com',
  'trafficmanager.net', 'blob.core.windows.net', 'azureedge.net', 'microsoft.com',
];

const DEFAULT_MEDIA_AUTH_ALLOW_HOSTS = [
  'api.botframework.com', 'botframework.com', 'smba.trafficmanager.net',
  'graph.microsoft.com', 'graph.microsoft.us', 'graph.microsoft.de', 'graph.microsoft.cn',
];

const GRAPH_SHARED_LINK_HOST_SUFFIXES = [
  '.sharepoint.com', '.sharepoint.us', '.sharepoint.de', '.sharepoint.cn',
  '.sharepoint-df.com', '1drv.ms', 'onedrive.live.com', 'onedrive.com',
];

function safeHostname(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ''; }
}

function isUrlAllowed(url, allowHosts) {
  const host = safeHostname(url);
  if (!host) return false;
  return allowHosts.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

function isAuthAllowed(url) {
  return isUrlAllowed(url, DEFAULT_MEDIA_AUTH_ALLOW_HOSTS);
}

function isBotFrameworkPersonalChatId(conversationId) {
  if (typeof conversationId !== 'string') return false;
  const trimmed = conversationId.trim();
  return trimmed.startsWith('a:') || trimmed.startsWith('8:orgid:');
}

function encodeGraphShareId(url) {
  return `u!${Buffer.from(url, 'utf8').toString('base64url')}`;
}

function isGraphSharedLinkUrl(url) {
  const host = safeHostname(url);
  if (!host) return false;
  return GRAPH_SHARED_LINK_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(suffix));
}

function tryBuildGraphSharesUrl(url) {
  if (!isGraphSharedLinkUrl(url)) return undefined;
  return `${GRAPH_BASE}/shares/${encodeGraphShareId(url)}/driveItem/content`;
}

function normalizeServiceUrl(serviceUrl) {
  return serviceUrl.replace(/\/+$/, '');
}

function inferPlaceholder(contentType, fileName) {
  const mime = (contentType || '').toLowerCase();
  const name = (fileName || '').toLowerCase();
  if (mime.startsWith('image/') || IMAGE_EXT_RE.test(name)) return '<media:image>';
  return '<media:document>';
}

function isDownloadableAttachment(att) {
  const ct = (att.contentType || '').trim();
  if (ct === 'application/vnd.microsoft.teams.file.download.info' &&
      att.content && typeof att.content === 'object' &&
      typeof att.content.downloadUrl === 'string') return true;
  if (typeof att.contentUrl === 'string' && att.contentUrl.trim()) return true;
  return false;
}

function isHtmlAttachment(att) {
  return (att.contentType || '').trim().startsWith('text/html');
}

function extractHtmlContent(att) {
  if (!isHtmlAttachment(att)) return undefined;
  if (typeof att.content === 'string') return att.content;
  if (att.content && typeof att.content === 'object') {
    return att.content.text || att.content.body || att.content.content || undefined;
  }
  return undefined;
}

function extractHtmlAttachmentIds(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const ids = new Set();
  for (const att of list) {
    const html = extractHtmlContent(att);
    if (!html) continue;
    ATTACHMENT_TAG_RE.lastIndex = 0;
    let match = ATTACHMENT_TAG_RE.exec(html);
    while (match) {
      const id = match[1]?.trim();
      if (id) ids.add(id);
      match = ATTACHMENT_TAG_RE.exec(html);
    }
  }
  return Array.from(ids);
}

function resolveDownloadCandidate(att) {
  const contentType = (att.contentType || '').trim();
  const name = (att.name || '').trim();

  if (contentType === 'application/vnd.microsoft.teams.file.download.info') {
    if (!att.content || typeof att.content !== 'object') return null;
    const downloadUrl = (att.content.downloadUrl || '').trim();
    if (!downloadUrl) return null;
    const fileType = (att.content.fileType || '').trim();
    const fileName = (att.content.fileName || '').trim();
    const uniqueId = (att.content.uniqueId || '').trim();
    const fileHint = name || fileName || (uniqueId && fileType ? `${uniqueId}.${fileType}` : '');
    return {
      url: downloadUrl,
      fileHint: fileHint || undefined,
      contentTypeHint: undefined,
      placeholder: inferPlaceholder(contentType, fileHint || `.${fileType}`),
    };
  }

  const contentUrl = (att.contentUrl || '').trim();
  if (!contentUrl) return null;
  const sharesUrl = tryBuildGraphSharesUrl(contentUrl);
  return {
    url: sharesUrl ?? contentUrl,
    fileHint: name || undefined,
    contentTypeHint: sharesUrl ? undefined : contentType,
    placeholder: inferPlaceholder(contentType, name),
  };
}

function mimeFromHeaderAndName(headerMime, fileName) {
  if (headerMime && !headerMime.includes('octet-stream')) return headerMime.split(';')[0].trim();
  const ext = fileName ? path.extname(fileName).toLowerCase().slice(1) : '';
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    pdf: 'application/pdf', doc: 'application/msword', zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
  };
  return map[ext] || headerMime || 'application/octet-stream';
}

async function saveBuffer(buffer, filename) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const safeName = (filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(MEDIA_DIR, `${Date.now()}_${safeName}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function scopeCandidatesForUrl(url) {
  const host = safeHostname(url);
  if (host.endsWith('graph.microsoft.com') || host.endsWith('sharepoint.com') ||
      host.endsWith('1drv.ms') || host.includes('sharepoint'))
    return [GRAPH_SCOPE, BOT_FRAMEWORK_SCOPE];
  return [BOT_FRAMEWORK_SCOPE, GRAPH_SCOPE];
}

async function fetchWithAuthFallback(url, tokenProvider) {
  if (!isUrlAllowed(url, DEFAULT_MEDIA_ALLOW_HOSTS)) return null;

  // Try unauthenticated first
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (res.ok) return res;
    if (res.status !== 401 && res.status !== 403) return null;
  } catch { /* fall through to auth attempts */ }

  if (!tokenProvider || !isAuthAllowed(url)) return null;

  const scopes = scopeCandidatesForUrl(url);
  for (const scope of scopes) {
    try {
      const token = await tokenProvider(scope);
      if (!token) continue;
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return res;
      if (res.status !== 401 && res.status !== 403) continue;
    } catch { /* try next scope */ }
  }
  return null;
}

async function downloadAndSave(url, fileHint, contentTypeHint, tokenProvider) {
  const res = await fetchWithAuthFallback(url, tokenProvider);
  if (!res) return null;

  const contentLength = res.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_MEDIA_BYTES) return null;

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength > MAX_MEDIA_BYTES || buffer.byteLength === 0) return null;

  const headerMime = res.headers.get('content-type') || undefined;
  const mime = mimeFromHeaderAndName(headerMime, fileHint);
  const savedPath = await saveBuffer(buffer, fileHint || 'attachment');

  return {
    path: savedPath,
    contentType: mime,
    placeholder: inferPlaceholder(mime, fileHint),
  };
}

// Tier 1: Direct download from activity attachments
async function downloadAttachments(attachments, tokenProvider) {
  const list = Array.isArray(attachments) ? attachments : [];
  const downloadable = list.filter(isDownloadableAttachment);
  const candidates = downloadable.map(resolveDownloadCandidate).filter(Boolean);

  // Also extract inline image URLs from HTML attachments
  for (const att of list) {
    const html = extractHtmlContent(att);
    if (!html) continue;
    IMG_SRC_RE.lastIndex = 0;
    let match = IMG_SRC_RE.exec(html);
    while (match) {
      const src = match[1]?.trim();
      if (src && !src.startsWith('cid:') && !src.startsWith('data:')) {
        if (isUrlAllowed(src, DEFAULT_MEDIA_ALLOW_HOSTS)) {
          candidates.push({ url: src, fileHint: undefined, contentTypeHint: undefined, placeholder: '<media:image>' });
        }
      }
      match = IMG_SRC_RE.exec(html);
    }
  }

  if (candidates.length === 0) return [];

  const out = [];
  const seenUrls = new Set();
  for (const candidate of candidates) {
    if (seenUrls.has(candidate.url)) continue;
    seenUrls.add(candidate.url);
    if (!isUrlAllowed(candidate.url, DEFAULT_MEDIA_ALLOW_HOSTS)) continue;
    try {
      const media = await downloadAndSave(candidate.url, candidate.fileHint, candidate.contentTypeHint, tokenProvider);
      if (media) out.push(media);
    } catch (err) {
      console.warn(`[teams/attachments] download failed: ${err.message}`);
    }
  }
  return out;
}

// Tier 2: Bot Framework v3 /attachments/{id} endpoint
async function downloadBotFrameworkAttachments({ serviceUrl, attachmentIds, tokenProvider }) {
  if (!serviceUrl || !attachmentIds?.length || !tokenProvider) return [];

  let accessToken;
  try {
    accessToken = await tokenProvider(BOT_FRAMEWORK_SCOPE);
  } catch (err) {
    console.warn(`[teams/attachments] BF token failed: ${err.message}`);
    return [];
  }
  if (!accessToken) return [];

  const baseUrl = normalizeServiceUrl(serviceUrl);
  const out = [];

  for (const attachmentId of [...new Set(attachmentIds)]) {
    const infoUrl = `${baseUrl}/v3/attachments/${encodeURIComponent(attachmentId)}`;
    if (!isUrlAllowed(infoUrl, DEFAULT_MEDIA_ALLOW_HOSTS)) continue;

    try {
      const infoRes = await fetch(infoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!infoRes.ok) continue;

      const info = await infoRes.json();
      const views = Array.isArray(info.views) ? info.views : [];
      const view = views.find(v => v?.viewId === 'original') || views.find(v => typeof v?.viewId === 'string');
      if (!view?.viewId) continue;

      if (typeof view.size === 'number' && view.size > MAX_MEDIA_BYTES) continue;

      const viewUrl = `${baseUrl}/v3/attachments/${encodeURIComponent(attachmentId)}/views/${encodeURIComponent(view.viewId)}`;
      const viewRes = await fetch(viewUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!viewRes.ok) continue;

      const cl = viewRes.headers.get('content-length');
      if (cl && Number(cl) > MAX_MEDIA_BYTES) continue;

      const buffer = Buffer.from(await viewRes.arrayBuffer());
      if (buffer.byteLength > MAX_MEDIA_BYTES || buffer.byteLength === 0) continue;

      const fileHint = info.name || undefined;
      const contentTypeHint = info.type || viewRes.headers.get('content-type') || undefined;
      const mime = mimeFromHeaderAndName(contentTypeHint, fileHint);
      const savedPath = await saveBuffer(buffer, fileHint || 'attachment');

      out.push({
        path: savedPath,
        contentType: mime,
        placeholder: inferPlaceholder(mime, fileHint),
      });
    } catch (err) {
      console.warn(`[teams/attachments] BF attachment download failed: ${err.message}`);
    }
  }
  return out;
}

// Tier 3: Graph API — fetch message, download SharePoint references + hosted content
async function downloadGraphMedia({ messageUrls, tokenProvider }) {
  if (!messageUrls?.length || !tokenProvider) return [];

  let accessToken;
  try {
    accessToken = await tokenProvider(GRAPH_SCOPE);
  } catch (err) {
    console.warn(`[teams/attachments] Graph token failed: ${err.message}`);
    return [];
  }
  if (!accessToken) return [];

  const out = [];

  for (const messageUrl of messageUrls) {
    // Fetch the message from Graph to get full attachment details
    let msgData;
    try {
      const msgRes = await fetch(messageUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      console.debug(`[teams/attachments] Graph fetch ${messageUrl} → ${msgRes.status}`);
      if (!msgRes.ok) {
        const errBody = await msgRes.text().catch(() => '');
        console.debug(`[teams/attachments] Graph error body: ${errBody.substring(0, 300)}`);
        continue;
      }
      msgData = await msgRes.json();
    } catch (err) {
      console.warn(`[teams/attachments] Graph message fetch failed: ${err.message}`);
      continue;
    }

    const attachments = Array.isArray(msgData.attachments) ? msgData.attachments : [];
    console.debug(`[teams/attachments] Graph message attachments: ${JSON.stringify(attachments.map(a => ({ id: a.id, contentType: a.contentType, name: a.name, contentUrl: (a.contentUrl || '').substring(0, 100) })))}`);

    // Download SharePoint "reference" attachments via /shares/ endpoint
    for (const att of attachments) {
      if ((att.contentType || '').toLowerCase() !== 'reference' || !att.contentUrl) continue;
      try {
        const sharesUrl = `${GRAPH_BASE}/shares/${encodeGraphShareId(att.contentUrl)}/driveItem/content`;
        const res = await fetch(sharesUrl, {
          redirect: 'follow',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) continue;

        const cl = res.headers.get('content-length');
        if (cl && Number(cl) > MAX_MEDIA_BYTES) continue;

        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.byteLength > MAX_MEDIA_BYTES || buffer.byteLength === 0) continue;

        const name = att.name || 'file';
        const mime = mimeFromHeaderAndName(res.headers.get('content-type'), name);
        const savedPath = await saveBuffer(buffer, name);
        out.push({ path: savedPath, contentType: mime, placeholder: inferPlaceholder(mime, name) });
      } catch (err) {
        console.warn(`[teams/attachments] SharePoint download failed: ${err.message}`);
      }
    }

    // Download hosted content (inline images)
    try {
      const hostedRes = await fetch(`${messageUrl}/hostedContents`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (hostedRes.ok) {
        const hostedData = await hostedRes.json();
        for (const item of (hostedData.value || [])) {
          if (item.contentBytes) {
            const buffer = Buffer.from(item.contentBytes, 'base64');
            if (buffer.byteLength > MAX_MEDIA_BYTES || buffer.byteLength === 0) continue;
            const mime = mimeFromHeaderAndName(item.contentType, undefined);
            const savedPath = await saveBuffer(buffer, `hosted.${(mime || '').split('/')[1] || 'bin'}`);
            out.push({ path: savedPath, contentType: mime, placeholder: inferPlaceholder(mime) });
          } else if (item.id) {
            const valRes = await fetch(`${messageUrl}/hostedContents/${encodeURIComponent(item.id)}/$value`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!valRes.ok) continue;
            const cl = valRes.headers.get('content-length');
            if (cl && Number(cl) > MAX_MEDIA_BYTES) continue;
            const buffer = Buffer.from(await valRes.arrayBuffer());
            if (buffer.byteLength > MAX_MEDIA_BYTES || buffer.byteLength === 0) continue;
            const mime = mimeFromHeaderAndName(valRes.headers.get('content-type'), undefined);
            const savedPath = await saveBuffer(buffer, `hosted.${(mime || '').split('/')[1] || 'bin'}`);
            out.push({ path: savedPath, contentType: mime, placeholder: inferPlaceholder(mime) });
          }
        }
      }
    } catch (err) {
      console.warn(`[teams/attachments] Graph hosted content fetch failed: ${err.message}`);
    }

    // Also download remaining non-reference attachments from Graph message
    const nonRefAtts = attachments.filter(a =>
      (a.contentType || '').toLowerCase() !== 'reference' && isDownloadableAttachment(a)
    );
    for (const att of nonRefAtts) {
      const candidate = resolveDownloadCandidate(att);
      if (!candidate || !isUrlAllowed(candidate.url, DEFAULT_MEDIA_ALLOW_HOSTS)) continue;
      try {
        const media = await downloadAndSave(candidate.url, candidate.fileHint, candidate.contentTypeHint,
          (scope) => tokenProvider(scope));
        if (media) out.push(media);
      } catch (err) {
        console.warn(`[teams/attachments] Graph attachment download failed: ${err.message}`);
      }
    }

    if (out.length > 0) break;
  }

  return out;
}

function buildGraphMessageUrls({ conversationType, conversationId, activity }) {
  const messageId = activity.id;
  const replyToId = activity.replyToId;
  const channelData = activity.channelData;

  const candidates = new Set();
  if (messageId) candidates.add(messageId.trim());
  const cdMsgId = channelData?.messageId || channelData?.teamsMessageId;
  if (cdMsgId) candidates.add(String(cdMsgId).trim());

  if (conversationType === 'channel') {
    const teamId = channelData?.team?.aadGroupId || channelData?.team?.id || channelData?.teamId;
    const channelId = channelData?.teamsChannelId || channelData?.channel?.id || channelData?.channelId;
    if (!teamId || !channelId) return [];
    // Extract thread root from conversationId (;messageid=XXXX) as fallback for replyToId
    const threadMatch = (conversationId || '').match(/;messageid=(\d+)/);
    const threadRootId = replyToId || (threadMatch ? threadMatch[1] : '');
    const urls = [];
    if (threadRootId) {
      for (const c of candidates) {
        if (c === threadRootId) continue;
        urls.push(`${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(threadRootId)}/replies/${encodeURIComponent(c)}`);
      }
    }
    if (candidates.size === 0 && threadRootId) candidates.add(threadRootId);
    for (const c of candidates)
      urls.push(`${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(c)}`);
    return [...new Set(urls)];
  }

  const chatId = (conversationId || '').trim() || channelData?.chatId;
  if (!chatId) return [];
  if (candidates.size === 0 && replyToId) candidates.add(replyToId);
  return [...candidates].map(c =>
    `${GRAPH_BASE}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(c)}`
  );
}

export {
  safeHostname, isUrlAllowed, isAuthAllowed,
  isBotFrameworkPersonalChatId,
  encodeGraphShareId, isGraphSharedLinkUrl, tryBuildGraphSharesUrl,
  normalizeServiceUrl, inferPlaceholder,
  isDownloadableAttachment, isHtmlAttachment, extractHtmlContent, extractHtmlAttachmentIds,
  resolveDownloadCandidate, mimeFromHeaderAndName, buildGraphMessageUrls,
};

async function downloadGraphNearbyFiles({ conversationType, conversationId, activity, tokenProvider }) {
  let accessToken;
  try {
    accessToken = await tokenProvider(GRAPH_SCOPE);
  } catch { return []; }
  if (!accessToken) return [];

  let url;
  if (conversationType === 'channel') {
    const channelData = activity.channelData || {};
    const teamId = channelData.team?.aadGroupId || channelData.team?.id || channelData.teamId;
    const channelId = channelData.teamsChannelId || channelData.channel?.id || channelData.channelId;
    if (!teamId || !channelId) return [];
    const threadMatch = (activity.conversation?.id || '').match(/;messageid=(\d+)/);
    const threadRootId = threadMatch ? threadMatch[1] : '';
    url = threadRootId
      ? `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(threadRootId)}/replies?$top=5&$orderby=createdDateTime desc`
      : `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=5&$orderby=createdDateTime desc`;
  } else {
    const chatId = (conversationId || '').trim();
    if (!chatId) return [];
    url = `${GRAPH_BASE}/chats/${encodeURIComponent(chatId)}/messages?$top=5&$orderby=createdDateTime desc`;
  }

  let messages;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return [];
    const data = await res.json();
    messages = data.value || [];
  } catch { return []; }

  const senderAad = activity.from?.aadObjectId || '';
  const activityTime = activity.timestamp ? new Date(activity.timestamp).getTime() : Date.now();

  const out = [];
  for (const msg of messages) {
    if (msg.id === activity.id) continue;
    const msgSenderAad = msg.from?.user?.id || '';
    if (senderAad && msgSenderAad !== senderAad) continue;
    const msgTime = msg.createdDateTime ? new Date(msg.createdDateTime).getTime() : 0;
    if (Math.abs(activityTime - msgTime) > 60_000) continue;

    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    for (const att of atts) {
      if ((att.contentType || '').toLowerCase() !== 'reference' || !att.contentUrl) continue;
      try {
        const sharesUrl = `${GRAPH_BASE}/shares/${encodeGraphShareId(att.contentUrl)}/driveItem/content`;
        const res = await fetch(sharesUrl, {
          redirect: 'follow',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) continue;
        const cl = res.headers.get('content-length');
        if (cl && Number(cl) > MAX_MEDIA_BYTES) continue;
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.byteLength > MAX_MEDIA_BYTES || buffer.byteLength === 0) continue;
        const name = att.name || 'file';
        const mime = mimeFromHeaderAndName(res.headers.get('content-type'), name);
        const savedPath = await saveBuffer(buffer, name);
        out.push({ path: savedPath, contentType: mime, placeholder: inferPlaceholder(mime, name) });
      } catch { /* skip failed downloads */ }
    }
    if (out.length > 0) break;
  }
  return out;
}

export async function resolveInboundMedia({ attachments, conversationType, conversationId, serviceUrl, activity, delegatedToken }) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];

  const tokenProvider = delegatedToken
    ? (_scope) => Promise.resolve(delegatedToken)
    : isGraphEnabled()
      ? (scope) => acquireTokenForScope(scope)
      : null;

  // Tier 1: direct download from activity attachments
  let media = await downloadAttachments(attachments, tokenProvider);
  if (media.length > 0) {
    console.log(`[teams/attachments] Tier 1: downloaded ${media.length} file(s)`);
    return media;
  }

  // Check if HTML contains <attachment> tags indicating embedded files
  const attachmentIds = extractHtmlAttachmentIds(attachments);

  // In personal chats, <attachment> tags are the only signal for embedded files.
  // In group/channel chats, Bot Framework omits file attachments entirely,
  // so we must fall through to Tier 3 (Graph API) regardless.
  if (attachmentIds.length === 0 && isBotFrameworkPersonalChatId(conversationId)) return [];

  // Tier 2: Bot Framework v3 endpoint (for DM conversations)
  if (attachmentIds.length > 0 && isBotFrameworkPersonalChatId(conversationId)) {
    if (!serviceUrl) {
      console.debug('[teams/attachments] BF attachment skipped (missing serviceUrl)');
    } else {
      media = await downloadBotFrameworkAttachments({
        serviceUrl,
        attachmentIds,
        tokenProvider,
      });
      if (media.length > 0) {
        console.log(`[teams/attachments] Tier 2 (BF v3): downloaded ${media.length} file(s)`);
        return media;
      }
    }
  }

  // Tier 3: Graph API (for group/channel, or when BF fails)
  if (!isBotFrameworkPersonalChatId(conversationId) && tokenProvider) {
    const messageUrls = buildGraphMessageUrls({ conversationType, conversationId, activity });
    console.debug(`[teams/attachments] Tier 3: messageUrls=${JSON.stringify(messageUrls)}`);
    if (messageUrls.length > 0) {
      media = await downloadGraphMedia({ messageUrls, tokenProvider });
      console.debug(`[teams/attachments] Tier 3: downloadGraphMedia returned ${media.length} file(s)`);
      if (media.length > 0) {
        console.log(`[teams/attachments] Tier 3 (Graph): downloaded ${media.length} file(s)`);
        return media;
      }
    }

    // Tier 3b: check nearby messages for file uploads sent separately from @mention
    media = await downloadGraphNearbyFiles({ conversationType, conversationId, activity, tokenProvider });
    if (media.length > 0) {
      console.log(`[teams/attachments] Tier 3b (Graph nearby): downloaded ${media.length} file(s)`);
      return media;
    }
  } else {
    console.debug(`[teams/attachments] Tier 3 skipped: isBF=${isBotFrameworkPersonalChatId(conversationId)}, hasToken=${!!tokenProvider}`);
  }

  return [];
}
