import test from 'node:test';
import assert from 'node:assert/strict';

import {
  safeHostname, isUrlAllowed, isAuthAllowed,
  isBotFrameworkPersonalChatId,
  encodeGraphShareId, isGraphSharedLinkUrl, tryBuildGraphSharesUrl,
  normalizeServiceUrl, inferPlaceholder,
  isDownloadableAttachment, isHtmlAttachment, extractHtmlContent, extractHtmlAttachmentIds,
  resolveDownloadCandidate, mimeFromHeaderAndName, buildGraphMessageUrls,
} from '../src/lib/attachments.js';

// --- safeHostname ---

test('extracts hostname from valid URL', () => {
  assert.equal(safeHostname('https://graph.microsoft.com/v1.0/me'), 'graph.microsoft.com');
});

test('returns empty string for invalid URL', () => {
  assert.equal(safeHostname('not-a-url'), '');
  assert.equal(safeHostname(''), '');
});

// --- isUrlAllowed ---

test('allows exact host match', () => {
  assert.equal(isUrlAllowed('https://graph.microsoft.com/path', ['graph.microsoft.com']), true);
});

test('allows subdomain match', () => {
  assert.equal(isUrlAllowed('https://sub.sharepoint.com/path', ['sharepoint.com']), true);
});

test('rejects unrecognized host', () => {
  assert.equal(isUrlAllowed('https://evil.com/path', ['graph.microsoft.com']), false);
});

test('rejects invalid URL', () => {
  assert.equal(isUrlAllowed('bad-url', ['graph.microsoft.com']), false);
});

// --- isAuthAllowed ---

test('allows Bot Framework URLs for auth', () => {
  assert.equal(isAuthAllowed('https://smba.trafficmanager.net/amer/v3/attachments/123'), true);
});

test('allows Graph URLs for auth', () => {
  assert.equal(isAuthAllowed('https://graph.microsoft.com/v1.0/me'), true);
});

test('rejects arbitrary URLs for auth', () => {
  assert.equal(isAuthAllowed('https://example.com/file'), false);
});

// --- isBotFrameworkPersonalChatId ---

test('recognizes a: prefix as personal chat', () => {
  assert.equal(isBotFrameworkPersonalChatId('a:1abc2def'), true);
});

test('recognizes 8:orgid: prefix as personal chat', () => {
  assert.equal(isBotFrameworkPersonalChatId('8:orgid:user@tenant'), true);
});

test('rejects group conversation IDs', () => {
  assert.equal(isBotFrameworkPersonalChatId('19:meeting_abc@thread.v2'), false);
});

test('rejects non-string input', () => {
  assert.equal(isBotFrameworkPersonalChatId(null), false);
  assert.equal(isBotFrameworkPersonalChatId(undefined), false);
  assert.equal(isBotFrameworkPersonalChatId(123), false);
});

// --- encodeGraphShareId ---

test('produces u! prefixed base64url encoding', () => {
  const result = encodeGraphShareId('https://contoso.sharepoint.com/doc.docx');
  assert.ok(result.startsWith('u!'));
  const decoded = Buffer.from(result.slice(2), 'base64url').toString('utf8');
  assert.equal(decoded, 'https://contoso.sharepoint.com/doc.docx');
});

// --- isGraphSharedLinkUrl ---

test('recognizes SharePoint URLs', () => {
  assert.equal(isGraphSharedLinkUrl('https://contoso.sharepoint.com/sites/doc'), true);
  assert.equal(isGraphSharedLinkUrl('https://contoso-my.sharepoint.com/personal/user'), true);
});

test('recognizes OneDrive URLs', () => {
  assert.equal(isGraphSharedLinkUrl('https://1drv.ms/w/s!abc'), true);
});

test('rejects non-shared-link URLs', () => {
  assert.equal(isGraphSharedLinkUrl('https://example.com/file'), false);
  assert.equal(isGraphSharedLinkUrl('https://graph.microsoft.com/v1.0/me'), false);
});

// --- tryBuildGraphSharesUrl ---

test('builds shares URL for SharePoint link', () => {
  const url = 'https://contoso.sharepoint.com/doc.docx';
  const result = tryBuildGraphSharesUrl(url);
  assert.ok(result.startsWith('https://graph.microsoft.com/v1.0/shares/u!'));
  assert.ok(result.endsWith('/driveItem/content'));
});

test('returns undefined for non-shared-link URL', () => {
  assert.equal(tryBuildGraphSharesUrl('https://example.com/file'), undefined);
});

// --- normalizeServiceUrl ---

test('strips trailing slashes', () => {
  assert.equal(normalizeServiceUrl('https://smba.trafficmanager.net/amer/'), 'https://smba.trafficmanager.net/amer');
  assert.equal(normalizeServiceUrl('https://smba.trafficmanager.net/amer///'), 'https://smba.trafficmanager.net/amer');
});

test('leaves clean URL unchanged', () => {
  assert.equal(normalizeServiceUrl('https://smba.trafficmanager.net/amer'), 'https://smba.trafficmanager.net/amer');
});

// --- inferPlaceholder ---

test('returns image placeholder for image content types', () => {
  assert.equal(inferPlaceholder('image/png', 'photo.png'), '<media:image>');
  assert.equal(inferPlaceholder('image/jpeg', ''), '<media:image>');
});

test('returns image placeholder for image file extensions', () => {
  assert.equal(inferPlaceholder('', 'photo.jpg'), '<media:image>');
  assert.equal(inferPlaceholder('application/octet-stream', 'img.webp'), '<media:image>');
});

test('returns document placeholder for non-image types', () => {
  assert.equal(inferPlaceholder('application/pdf', 'doc.pdf'), '<media:document>');
  assert.equal(inferPlaceholder('', 'report.docx'), '<media:document>');
});

// --- isDownloadableAttachment ---

test('recognizes file.download.info attachment', () => {
  assert.equal(isDownloadableAttachment({
    contentType: 'application/vnd.microsoft.teams.file.download.info',
    content: { downloadUrl: 'https://example.com/file.pdf' }
  }), true);
});

test('recognizes attachment with contentUrl', () => {
  assert.equal(isDownloadableAttachment({
    contentType: 'image/png',
    contentUrl: 'https://example.com/img.png'
  }), true);
});

test('rejects attachment without download info or URL', () => {
  assert.equal(isDownloadableAttachment({ contentType: 'text/html', content: '<p>hi</p>' }), false);
  assert.equal(isDownloadableAttachment({ contentType: 'image/png', contentUrl: '' }), false);
});

// --- isHtmlAttachment / extractHtmlContent ---

test('identifies HTML attachments', () => {
  assert.equal(isHtmlAttachment({ contentType: 'text/html' }), true);
  assert.equal(isHtmlAttachment({ contentType: 'text/html; charset=utf-8' }), true);
  assert.equal(isHtmlAttachment({ contentType: 'image/png' }), false);
});

test('extracts HTML string content', () => {
  assert.equal(extractHtmlContent({ contentType: 'text/html', content: '<p>hi</p>' }), '<p>hi</p>');
});

test('extracts HTML from object content', () => {
  assert.equal(extractHtmlContent({ contentType: 'text/html', content: { text: 'hello' } }), 'hello');
  assert.equal(extractHtmlContent({ contentType: 'text/html', content: { body: 'body' } }), 'body');
});

test('returns undefined for non-HTML attachment', () => {
  assert.equal(extractHtmlContent({ contentType: 'image/png', contentUrl: 'x' }), undefined);
});

// --- extractHtmlAttachmentIds ---

test('extracts attachment IDs from HTML content', () => {
  const attachments = [{
    contentType: 'text/html',
    content: '<p>See file: <attachment id="abc-123"></attachment></p>'
  }];
  assert.deepEqual(extractHtmlAttachmentIds(attachments), ['abc-123']);
});

test('returns empty for no HTML attachments', () => {
  assert.deepEqual(extractHtmlAttachmentIds([{ contentType: 'image/png' }]), []);
  assert.deepEqual(extractHtmlAttachmentIds([]), []);
  assert.deepEqual(extractHtmlAttachmentIds(null), []);
});

test('deduplicates attachment IDs', () => {
  const attachments = [{
    contentType: 'text/html',
    content: '<attachment id="x"></attachment><attachment id="x"></attachment>'
  }];
  assert.deepEqual(extractHtmlAttachmentIds(attachments), ['x']);
});

// --- resolveDownloadCandidate ---

test('resolves file.download.info attachment', () => {
  const att = {
    contentType: 'application/vnd.microsoft.teams.file.download.info',
    name: 'report.pdf',
    content: { downloadUrl: 'https://example.com/file', fileType: 'pdf', fileName: 'report.pdf' }
  };
  const result = resolveDownloadCandidate(att);
  assert.equal(result.url, 'https://example.com/file');
  assert.equal(result.fileHint, 'report.pdf');
  assert.equal(result.placeholder, '<media:document>');
});

test('resolves contentUrl attachment with SharePoint shared link', () => {
  const att = {
    contentType: 'image/png',
    name: 'screenshot.png',
    contentUrl: 'https://contoso.sharepoint.com/sites/team/Shared/screenshot.png'
  };
  const result = resolveDownloadCandidate(att);
  assert.ok(result.url.includes('graph.microsoft.com/v1.0/shares/'));
  assert.equal(result.fileHint, 'screenshot.png');
  assert.equal(result.placeholder, '<media:image>');
});

test('resolves contentUrl with non-SharePoint URL directly', () => {
  const att = {
    contentType: 'image/png',
    name: 'img.png',
    contentUrl: 'https://media.ams.skype.com/img.png'
  };
  const result = resolveDownloadCandidate(att);
  assert.equal(result.url, 'https://media.ams.skype.com/img.png');
});

test('returns null for attachment without URL', () => {
  assert.equal(resolveDownloadCandidate({ contentType: 'text/html', content: 'hi' }), null);
});

// --- mimeFromHeaderAndName ---

test('returns header MIME when not octet-stream', () => {
  assert.equal(mimeFromHeaderAndName('image/png', 'file.jpg'), 'image/png');
  assert.equal(mimeFromHeaderAndName('text/plain; charset=utf-8', ''), 'text/plain');
});

test('infers from extension when header is octet-stream', () => {
  assert.equal(mimeFromHeaderAndName('application/octet-stream', 'doc.pdf'), 'application/pdf');
  assert.equal(mimeFromHeaderAndName('application/octet-stream', 'img.png'), 'image/png');
});

test('infers from extension when no header', () => {
  assert.equal(mimeFromHeaderAndName('', 'file.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('falls back to octet-stream for unknown extension', () => {
  assert.equal(mimeFromHeaderAndName('', 'file.xyz'), 'application/octet-stream');
});

// --- buildGraphMessageUrls ---

test('builds chat message URL for DM', () => {
  const urls = buildGraphMessageUrls({
    conversationType: 'dm',
    conversationId: 'a:chatid123',
    activity: { id: 'msg-1', channelData: {} }
  });
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('/chats/'));
  assert.ok(urls[0].includes('msg-1'));
});

test('builds channel message URL', () => {
  const urls = buildGraphMessageUrls({
    conversationType: 'channel',
    conversationId: '19:channel@thread',
    activity: {
      id: 'msg-2',
      channelData: { team: { id: 'team-1' }, channel: { id: '19:channel@thread' } }
    }
  });
  assert.ok(urls.length >= 1);
  assert.ok(urls[0].includes('/teams/'));
  assert.ok(urls[0].includes('/channels/'));
});

test('includes reply thread URL for channel messages with replyToId', () => {
  const urls = buildGraphMessageUrls({
    conversationType: 'channel',
    conversationId: '19:channel@thread',
    activity: {
      id: 'reply-1',
      replyToId: 'parent-1',
      channelData: { team: { id: 'team-1' }, channel: { id: '19:channel@thread' } }
    }
  });
  const replyUrls = urls.filter(u => u.includes('/replies/'));
  assert.ok(replyUrls.length >= 1);
});

test('returns empty for channel without teamId', () => {
  const urls = buildGraphMessageUrls({
    conversationType: 'channel',
    conversationId: '19:channel@thread',
    activity: { id: 'msg-3', channelData: {} }
  });
  assert.deepEqual(urls, []);
});

test('returns empty when no conversationId for DM', () => {
  const urls = buildGraphMessageUrls({
    conversationType: 'dm',
    conversationId: '',
    activity: { id: 'msg-4', channelData: {} }
  });
  assert.deepEqual(urls, []);
});
