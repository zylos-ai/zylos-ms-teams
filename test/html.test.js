import test from 'node:test';
import assert from 'node:assert/strict';

import { htmlToText, extractQuotedReply } from '../src/lib/html.js';

// --- htmlToText ---

test('returns empty string for falsy input', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(undefined), '');
});

test('returns plain text unchanged', () => {
  assert.equal(htmlToText('Hello world'), 'Hello world');
});

test('strips simple HTML tags', () => {
  assert.equal(htmlToText('<p>Hello</p>'), 'Hello');
});

test('converts <br> to newlines', () => {
  assert.equal(htmlToText('line1<br>line2'), 'line1\nline2');
  assert.equal(htmlToText('line1<br/>line2'), 'line1\nline2');
  assert.equal(htmlToText('line1<br />line2'), 'line1\nline2');
});

test('converts list items to bullets', () => {
  const html = '<ul><li>first</li><li>second</li></ul>';
  const result = htmlToText(html);
  assert.ok(result.includes('- first'));
  assert.ok(result.includes('- second'));
});

test('converts links to text (url) format', () => {
  assert.equal(
    htmlToText('<a href="https://example.com">Example</a>'),
    'Example (https://example.com)'
  );
});

test('link with matching text and href shows URL only', () => {
  assert.equal(
    htmlToText('<a href="https://example.com">https://example.com</a>'),
    'https://example.com'
  );
});

test('converts code blocks', () => {
  const html = '<pre><code>const x = 1;</code></pre>';
  const result = htmlToText(html);
  assert.ok(result.includes('const x = 1;'));
});

test('converts inline code', () => {
  assert.equal(htmlToText('use <code>npm test</code> to run'), 'use `npm test` to run');
});

test('strips bold/italic tags keeping content', () => {
  assert.equal(htmlToText('<b>bold</b> and <i>italic</i>'), 'bold and italic');
  assert.equal(htmlToText('<strong>strong</strong> and <em>emphasis</em>'), 'strong and emphasis');
});

test('strips Teams <at> mention tags keeping name', () => {
  assert.equal(htmlToText('<at>Zylos Bot</at> hello'), 'Zylos Bot hello');
});

test('decodes HTML entities within HTML content', () => {
  assert.equal(htmlToText('<p>&amp; &lt; &gt; &quot; &#39;</p>'), '& < > " \'');
  assert.equal(htmlToText('<span>&#65;</span>'), 'A');
  assert.equal(htmlToText('<span>&#x41;</span>'), 'A');
});

test('returns plain text with entities unchanged (no tags = no processing)', () => {
  assert.equal(htmlToText('&amp; plain'), '&amp; plain');
});

test('collapses excessive blank lines', () => {
  const result = htmlToText('<p>a</p><p></p><p></p><p>b</p>');
  assert.ok(!result.includes('\n\n\n'));
});

test('handles nested block elements', () => {
  const result = htmlToText('<div><p>inner</p></div>');
  assert.ok(result.includes('inner'));
});

// --- extractQuotedReply ---

test('returns null when no attachments', () => {
  assert.equal(extractQuotedReply({}), null);
  assert.equal(extractQuotedReply({ attachments: [] }), null);
});

test('extracts messageReference reply', () => {
  const activity = {
    attachments: [{
      contentType: 'messageReference',
      content: {
        messageText: '<b>original</b> message',
        messageSender: { user: { displayName: 'Alice' } }
      }
    }]
  };
  const result = extractQuotedReply(activity);
  assert.equal(result.quotedText, 'original message');
  assert.equal(result.quotedFrom, 'Alice');
});

test('extracts messageReference from JSON string content', () => {
  const activity = {
    attachments: [{
      contentType: 'messageReference',
      content: JSON.stringify({
        messageText: 'quoted text',
        messageSender: { user: { displayName: 'Bob' } }
      })
    }]
  };
  const result = extractQuotedReply(activity);
  assert.equal(result.quotedText, 'quoted text');
  assert.equal(result.quotedFrom, 'Bob');
});

test('extracts legacy hero card reply', () => {
  const activity = {
    attachments: [{
      contentType: 'application/vnd.microsoft.card.hero',
      content: { text: 'old message', title: 'Charlie' }
    }]
  };
  const result = extractQuotedReply(activity);
  assert.equal(result.quotedText, 'old message');
  assert.equal(result.quotedFrom, 'Charlie');
});

test('falls back to messagePreview when messageText is empty', () => {
  const activity = {
    attachments: [{
      contentType: 'messageReference',
      content: {
        messageText: '',
        messagePreview: 'preview text',
        messageSender: { user: { displayName: 'Dave' } }
      }
    }]
  };
  const result = extractQuotedReply(activity);
  assert.equal(result.quotedText, 'preview text');
});

test('returns null for unrecognized attachment types', () => {
  const activity = {
    attachments: [{ contentType: 'image/png', contentUrl: 'https://example.com/img.png' }]
  };
  assert.equal(extractQuotedReply(activity), null);
});
