import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeXml, buildEndpoint, parseC4Response, getConversationType, formatMessage } from '../src/lib/format.js';

// --- escapeXml ---

test('escapes all XML special characters', () => {
  assert.equal(escapeXml('&<>\'"'), '&amp;&lt;&gt;&apos;&quot;');
});

test('returns empty string for null/undefined', () => {
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(undefined), '');
});

test('coerces non-string to string', () => {
  assert.equal(escapeXml(42), '42');
});

test('leaves clean text unchanged', () => {
  assert.equal(escapeXml('Hello world'), 'Hello world');
});

// --- buildEndpoint ---

test('builds endpoint with all fields', () => {
  assert.equal(
    buildEndpoint('conv-123', { type: 'dm', aadObjectId: 'user-1', activityId: 'msg-1' }),
    'conv-123|type:dm|user:user-1|msg:msg-1'
  );
});

test('builds endpoint with only conversationId', () => {
  assert.equal(buildEndpoint('conv-123'), 'conv-123');
});

test('builds endpoint with partial options', () => {
  assert.equal(
    buildEndpoint('conv-123', { type: 'group' }),
    'conv-123|type:group'
  );
});

test('omits falsy optional fields', () => {
  assert.equal(
    buildEndpoint('conv-123', { type: 'dm', aadObjectId: '', activityId: null }),
    'conv-123|type:dm'
  );
});

// --- parseC4Response ---

test('parses valid JSON', () => {
  assert.deepEqual(parseC4Response('{"status":"ok"}'), { status: 'ok' });
});

test('trims whitespace before parsing', () => {
  assert.deepEqual(parseC4Response('  {"a":1}\n'), { a: 1 });
});

test('returns null for invalid JSON', () => {
  assert.equal(parseC4Response('not json'), null);
});

test('returns null for empty/null input', () => {
  assert.equal(parseC4Response(''), null);
  assert.equal(parseC4Response(null), null);
  assert.equal(parseC4Response(undefined), null);
});

// --- getConversationType ---

test('maps personal to dm', () => {
  assert.equal(getConversationType({ conversation: { conversationType: 'personal' } }), 'dm');
});

test('maps groupChat to group', () => {
  assert.equal(getConversationType({ conversation: { conversationType: 'groupChat' } }), 'group');
});

test('maps channel to channel', () => {
  assert.equal(getConversationType({ conversation: { conversationType: 'channel' } }), 'channel');
});

test('defaults to dm for unknown type', () => {
  assert.equal(getConversationType({ conversation: { conversationType: 'unknown' } }), 'dm');
  assert.equal(getConversationType({ conversation: {} }), 'dm');
  assert.equal(getConversationType({}), 'dm');
});

// --- formatMessage ---

test('formats DM message', () => {
  const result = formatMessage('dm', 'Alice', 'hello');
  assert.ok(result.startsWith('[Teams DM] Alice said: '));
  assert.ok(result.includes('<current-message>\nhello\n</current-message>'));
});

test('formats group message with group name', () => {
  const result = formatMessage('group', 'Bob', 'hi', { groupName: 'Dev Team' });
  assert.ok(result.startsWith('[Teams GROUP:Dev Team] Bob said: '));
});

test('defaults group name to unknown', () => {
  const result = formatMessage('group', 'Bob', 'hi');
  assert.ok(result.includes('GROUP:unknown'));
});

test('escapes XML in user name and text', () => {
  const result = formatMessage('dm', '<script>', 'a & b');
  assert.ok(result.includes('&lt;script&gt;'));
  assert.ok(result.includes('a &amp; b'));
});

test('includes quoted reply when present', () => {
  const result = formatMessage('dm', 'Alice', 'reply', {
    quotedReply: { quotedFrom: 'Bob', quotedText: 'original' }
  });
  assert.ok(result.includes('<quoted-reply from="Bob">original</quoted-reply>'));
});

test('includes context block when present', () => {
  const result = formatMessage('dm', 'Alice', 'msg', { contextBlock: '[context]' });
  assert.ok(result.includes('[context]'));
  assert.ok(result.indexOf('[context]') < result.indexOf('<current-message>'));
});
