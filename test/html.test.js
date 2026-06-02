import { describe, it, expect } from 'vitest';
import { htmlToText, htmlToMarkdown, extractQuotedReply, extractReplyBlockquote } from '../src/lib/html.js';

describe('htmlToText', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(htmlToText(null)).toBe('');
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText('')).toBe('');
  });

  it('returns plain text unchanged', () => {
    expect(htmlToText('hello world')).toBe('hello world');
  });

  it('strips bold/italic tags', () => {
    expect(htmlToText('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
    expect(htmlToText('<strong>strong</strong> <em>emphasis</em>')).toBe('strong emphasis');
  });

  it('converts <br> to newline', () => {
    expect(htmlToText('line1<br>line2')).toBe('line1\nline2');
    expect(htmlToText('line1<br/>line2')).toBe('line1\nline2');
    expect(htmlToText('line1<br />line2')).toBe('line1\nline2');
  });

  it('converts <p> blocks to newlines', () => {
    const result = htmlToText('<p>para1</p><p>para2</p>');
    expect(result).toContain('para1');
    expect(result).toContain('para2');
    expect(result.includes('\n')).toBe(true);
  });

  it('converts links to text (url) format', () => {
    expect(htmlToText('<a href="https://example.com">click here</a>'))
      .toBe('click here (https://example.com)');
  });

  it('uses bare URL when link text matches href', () => {
    expect(htmlToText('<a href="https://x.com">https://x.com</a>'))
      .toBe('https://x.com');
  });

  it('converts inline code', () => {
    expect(htmlToText('use <code>foo()</code> here')).toBe('use `foo()` here');
  });

  it('converts <pre><code> blocks to fenced code', () => {
    const result = htmlToText('<pre><code>const x = 1;</code></pre>');
    expect(result).toContain('```');
    expect(result).toContain('const x = 1;');
  });

  it('converts <pre> blocks without <code>', () => {
    const result = htmlToText('<pre>raw text</pre>');
    expect(result).toContain('```');
    expect(result).toContain('raw text');
  });

  it('converts ordered lists', () => {
    const result = htmlToText('<ol><li>first</li><li>second</li></ol>');
    expect(result).toContain('1.');
    expect(result).toContain('2.');
    expect(result).toContain('first');
    expect(result).toContain('second');
  });

  it('converts unordered lists', () => {
    const result = htmlToText('<ul><li>alpha</li><li>beta</li></ul>');
    expect(result).toContain('- alpha');
    expect(result).toContain('- beta');
  });

  it('decodes named HTML entities', () => {
    expect(htmlToText('<p>&amp; &lt; &gt; &quot; &#39; &nbsp;end</p>')).toBe('& < > " \'  end');
  });

  it('decodes numeric entities', () => {
    expect(htmlToText('<p>&#65;&#66;&#67;</p>')).toBe('ABC');
  });

  it('decodes hex entities', () => {
    expect(htmlToText('<p>&#x41;&#x42;</p>')).toBe('AB');
  });

  it('extracts Teams @mention text', () => {
    expect(htmlToText('<at>@Zylos</at> hello')).toBe('@Zylos hello');
  });

  it('extracts emoji alt text', () => {
    expect(htmlToText('hey <emoji alt="😢"></emoji>')).toBe('hey 😢');
  });

  it('extracts img alt text (emoji images)', () => {
    expect(htmlToText('look <img alt="😊" src="x.png"/>')).toBe('look 😊');
  });

  it('collapses excessive blank lines', () => {
    const result = htmlToText('<p></p><p></p><p></p><p>text</p>');
    expect(result.match(/\n/g)?.length || 0).toBeLessThanOrEqual(3);
    expect(result).toContain('text');
  });

  it('handles <div> and <blockquote> blocks', () => {
    const result = htmlToText('<div>block1</div><blockquote>quote</blockquote>');
    expect(result).toContain('block1');
    expect(result).toContain('quote');
  });

  it('handles <h1>-<h6> headings', () => {
    const result = htmlToText('<h1>Title</h1><h3>Sub</h3>');
    expect(result).toContain('Title');
    expect(result).toContain('Sub');
  });
});

describe('htmlToMarkdown', () => {
  it('preserves rich formatting as markdown', () => {
    const result = htmlToMarkdown('<h2>Title</h2><p><strong>bold</strong> and <em>em</em></p><a href="https://example.com">link</a>');
    expect(result).toContain('## Title');
    expect(result).toContain('**bold**');
    expect(result).toContain('_em_');
    expect(result).toContain('[link](https://example.com)');
  });

  it('converts lists, blockquotes, and code blocks', () => {
    const result = htmlToMarkdown('<blockquote>quote</blockquote><ul><li>a</li><li>b</li></ul><pre><code>x = 1</code></pre>');
    expect(result).toContain('> quote');
    expect(result).toContain('- a');
    expect(result).toContain('- b');
    expect(result).toContain('```');
    expect(result).toContain('x = 1');
  });
});

describe('extractQuotedReply', () => {
  it('returns null for no attachments', () => {
    expect(extractQuotedReply({})).toBe(null);
    expect(extractQuotedReply({ attachments: [] })).toBe(null);
    expect(extractQuotedReply(null)).toBe(null);
  });

  it('extracts from messageReference attachment (object content)', () => {
    const activity = {
      attachments: [{
        contentType: 'messageReference',
        content: {
          messageText: '<b>hello</b>',
          messageSender: { user: { displayName: 'Alice' } },
        },
      }],
    };
    const result = extractQuotedReply(activity);
    expect(result).toEqual({ quotedText: 'hello', quotedFrom: 'Alice' });
  });

  it('extracts from messageReference attachment (JSON string content)', () => {
    const activity = {
      attachments: [{
        contentType: 'messageReference',
        content: JSON.stringify({
          messageText: 'quoted text',
          messageSender: { user: { displayName: 'Bob' } },
        }),
      }],
    };
    const result = extractQuotedReply(activity);
    expect(result).toEqual({ quotedText: 'quoted text', quotedFrom: 'Bob' });
  });

  it('falls back to messagePreview if no messageText', () => {
    const activity = {
      attachments: [{
        contentType: 'messageReference',
        content: { messagePreview: 'preview text' },
      }],
    };
    const result = extractQuotedReply(activity);
    expect(result.quotedText).toBe('preview text');
  });

  it('extracts from legacy hero card', () => {
    const activity = {
      attachments: [{
        contentType: 'application/vnd.microsoft.card.hero',
        content: { text: 'hero text', title: 'Sender' },
      }],
    };
    const result = extractQuotedReply(activity);
    expect(result).toEqual({ quotedText: 'hero text', quotedFrom: 'Sender' });
  });

  it('extracts from Skype blockquote HTML', () => {
    const html = '<blockquote itemtype="http://schema.skype.com/Reply"><span itemprop="mri">8:orgid:abc-123</span><span itemprop="preview">quoted content</span></blockquote>';
    const activity = {
      attachments: [{
        contentType: 'text/html',
        content: html,
      }],
    };
    const result = extractQuotedReply(activity);
    expect(result.quotedText).toBe('quoted content');
    expect(result.quotedFrom).toBe('abc-123');
  });

  it('skips messageReference with empty text', () => {
    const activity = {
      attachments: [{
        contentType: 'messageReference',
        content: { messageText: '', messageSender: { user: { displayName: 'X' } } },
      }],
    };
    expect(extractQuotedReply(activity)).toBe(null);
  });
});

describe('extractReplyBlockquote', () => {
  it('returns original html and null quote when no blockquote', () => {
    const result = extractReplyBlockquote('<p>hello</p>');
    expect(result).toEqual({ html: '<p>hello</p>', quote: null });
  });

  it('returns empty html and null quote for null/empty input', () => {
    expect(extractReplyBlockquote(null)).toEqual({ html: '', quote: null });
    expect(extractReplyBlockquote('')).toEqual({ html: '', quote: null });
  });

  it('extracts and removes Skype Reply blockquote', () => {
    const html = '<p>new message</p><blockquote itemtype="http://schema.skype.com/Reply"><p>old message</p></blockquote>';
    const result = extractReplyBlockquote(html);
    expect(result.html).toBe('<p>new message</p>');
    expect(result.quote).toContain('old message');
  });
});
