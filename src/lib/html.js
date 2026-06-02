/**
 * HTML-to-text processing for inbound Teams messages.
 *
 * Teams sends message text as HTML (with <p>, <at>, <b>, etc.).
 * This module converts it to readable plain text for C4 delivery.
 */

const ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * Decode HTML entities (named + numeric).
 */
function decodeEntities(text) {
  // Named entities
  let result = text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (match) => {
    return ENTITY_MAP[match] || match;
  });
  // Numeric entities: &#123; or &#x1a;
  result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return result;
}

/**
 * Convert an HTML string to readable plain text.
 *
 * Handles common Teams HTML tags: <p>, <br>, <b>, <i>, <a>, <pre>, <code>,
 * <ul>, <ol>, <li>, <div>, <span>, <blockquote>, <h1>-<h6>, <at>.
 *
 * @param {string} html - HTML string from Teams activity text
 * @returns {string} Plain text
 */
export function htmlToText(html) {
  if (!html) return '';
  if (!/<[^>]+>/.test(html)) return html;

  let text = html;

  // Normalize line endings
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // --- Process structured elements BEFORE generic block-level stripping ---

  // <pre><code>...</code></pre> -> preserve content with backticks
  text = text.replace(/<pre(?:\s[^>]*)?>\s*<code(?:\s[^>]*)?>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code) => {
    return '\n```\n' + code.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '') + '\n```\n';
  });

  // <pre>...</pre> -> preserve content
  text = text.replace(/<pre(?:\s[^>]*)?>([\s\S]*?)<\/pre>/gi, (_, code) => {
    return '\n```\n' + code.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '') + '\n```\n';
  });

  // Numbered lists: replace <li> inside <ol> with 1. 2. 3. format
  text = text.replace(/<ol(?:\s[^>]*)?>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let i = 0;
    return '\n' + inner.replace(/<li(?:\s[^>]*)?>/gi, () => `\n${++i}. `).replace(/<\/li>/gi, '');
  });

  // Bulleted lists: <li> inside <ul> -> "- "
  text = text.replace(/<ul(?:\s[^>]*)?>([\s\S]*?)<\/ul>/gi, (_, inner) => {
    return '\n' + inner.replace(/<li(?:\s[^>]*)?>/gi, '\n- ').replace(/<\/li>/gi, '');
  });

  // Standalone <li> (not inside ol/ul) -> "- "
  text = text.replace(/<li(?:\s[^>]*)?>/gi, '\n- ');
  text = text.replace(/<\/li>/gi, '');

  // --- Generic block-level stripping (ol/ul/pre already processed above) ---

  text = text.replace(/<\/(?:p|div|blockquote|h[1-6])>/gi, '\n');
  text = text.replace(/<(?:p|div|blockquote|h[1-6])(?:\s[^>]*)?>/gi, '\n');

  // <br> and <br/>
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // <a href="url">text</a> -> text (url)
  text = text.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, (_, href, linkText) => {
    const cleanLink = linkText.replace(/<[^>]+>/g, '').trim();
    if (!cleanLink || cleanLink === href) return href;
    return `${cleanLink} (${href})`;
  });

  // Inline <code>...</code>
  text = text.replace(/<code(?:\s[^>]*)?>(.*?)<\/code>/gi, '`$1`');

  // Bold/italic — extract content
  text = text.replace(/<(?:b|strong)(?:\s[^>]*)?>(.*?)<\/(?:b|strong)>/gi, '$1');
  text = text.replace(/<(?:i|em)(?:\s[^>]*)?>(.*?)<\/(?:i|em)>/gi, '$1');

  // <at>...</at> — Teams mention tags, keep inner text
  text = text.replace(/<at(?:\s[^>]*)?>(.*?)<\/at>/gi, '$1');

  // Emoji tags: <emoji alt="😢"> or <img alt="😢" ...> — extract alt text
  text = text.replace(/<(?:emoji|img)\s+[^>]*alt=["']([^"']+)["'][^>]*\/?>/gi, '$1');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = decodeEntities(text);

  // Collapse multiple blank lines into at most two newlines
  text = text.replace(/\n{3,}/g, '\n\n');

  // Trim leading/trailing whitespace
  text = text.trim();

  return text;
}

function stripTags(text) {
  return text.replace(/<[^>]+>/g, '');
}

function normalizeMarkdown(text) {
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert Teams HTML to Markdown for C4 delivery while preserving useful
 * structure for the agent.
 */
export function htmlToMarkdown(html) {
  if (!html) return '';
  if (!/<[^>]+>/.test(html)) return html;

  let text = html.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  text = text.replace(/<pre(?:\s[^>]*)?>\s*<code(?:\s[^>]*)?>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code) => {
    return `\n\`\`\`\n${stripTags(code.replace(/<br\s*\/?>/gi, '\n'))}\n\`\`\`\n`;
  });
  text = text.replace(/<pre(?:\s[^>]*)?>([\s\S]*?)<\/pre>/gi, (_, code) => {
    return `\n\`\`\`\n${stripTags(code.replace(/<br\s*\/?>/gi, '\n'))}\n\`\`\`\n`;
  });

  text = text.replace(/<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => {
    return `\n${'#'.repeat(Number(level))} ${stripTags(inner).trim()}\n`;
  });
  text = text.replace(/<blockquote(?:\s[^>]*)?>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    return `\n${htmlToMarkdown(inner).split('\n').map(line => line.trim() ? `> ${line}` : '>').join('\n')}\n`;
  });
  text = text.replace(/<ol(?:\s[^>]*)?>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let i = 0;
    return '\n' + inner.replace(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi, (_m, item) => `${++i}. ${htmlToMarkdown(item)}\n`);
  });
  text = text.replace(/<ul(?:\s[^>]*)?>([\s\S]*?)<\/ul>/gi, (_, inner) => {
    return '\n' + inner.replace(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi, (_m, item) => `- ${htmlToMarkdown(item)}\n`);
  });
  text = text.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, linkText) => {
    const cleanLink = htmlToMarkdown(linkText).trim();
    if (!cleanLink || cleanLink === href) return href;
    return `[${cleanLink}](${href})`;
  });
  text = text.replace(/<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/gi, (_, code) => `\`${stripTags(code)}\``);
  text = text.replace(/<(?:b|strong)(?:\s[^>]*)?>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**');
  text = text.replace(/<(?:i|em)(?:\s[^>]*)?>([\s\S]*?)<\/(?:i|em)>/gi, '_$1_');
  text = text.replace(/<at(?:\s[^>]*)?>([\s\S]*?)<\/at>/gi, '$1');
  text = text.replace(/<(?:emoji|img)\s+[^>]*alt=["']([^"']+)["'][^>]*\/?>/gi, '$1');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(?:p|div)>/gi, '\n');
  text = text.replace(/<(?:p|div)(?:\s[^>]*)?>/gi, '\n');
  text = text.replace(/<li(?:\s[^>]*)?>/gi, '\n- ');
  text = text.replace(/<\/li>/gi, '');
  text = stripTags(text);

  return normalizeMarkdown(text);
}

/**
 * Extract quoted reply text from a Teams message activity.
 *
 * When a user replies to a message in Teams, the original message is attached
 * as a Skype Reply attachment with contentType "messageReference".
 *
 * @param {object} activity - The Teams activity object
 * @returns {{ quotedText: string, quotedFrom: string } | null}
 */
export function extractQuotedReply(activity) {
  if (!activity?.attachments?.length) return null;

  for (const attachment of activity.attachments) {
    // Teams reply-chain attachments
    if (attachment.contentType === 'messageReference' && attachment.content) {
      const content = typeof attachment.content === 'string'
        ? tryParseJson(attachment.content)
        : attachment.content;

      if (!content) continue;

      const quotedText = content.messageText || content.messagePreview || '';
      const quotedFrom = content.messageSender?.user?.displayName || '';
      if (quotedText) {
        return {
          quotedText: htmlToText(quotedText),
          quotedFrom,
        };
      }
    }

    // Legacy Skype Reply schema
    if (attachment.contentType === 'application/vnd.microsoft.card.hero') {
      const content = typeof attachment.content === 'string'
        ? tryParseJson(attachment.content)
        : attachment.content;
      if (content?.text) {
        return {
          quotedText: htmlToText(content.text),
          quotedFrom: content.title || '',
        };
      }
    }

    // Skype blockquote HTML format in text/html attachments
    if ((attachment.contentType || '').startsWith('text/html')) {
      const html = typeof attachment.content === 'string'
        ? attachment.content
        : (attachment.content?.text || attachment.content?.body || '');
      const bqMatch = html.match(/<blockquote[^>]*itemtype=["']http:\/\/schema\.skype\.com\/Reply["'][^>]*>([\s\S]*?)<\/blockquote>/i);
      if (bqMatch) {
        const inner = bqMatch[1];
        const mriMatch = inner.match(/itemprop=["']mri["'][^>]*>([^<]*)</i);
        const previewMatch = inner.match(/itemprop=["']preview["'][^>]*>([\s\S]*?)<\//i);
        if (previewMatch) {
          const mriValue = mriMatch ? mriMatch[1].trim() : '';
          // Parse AAD object ID from mri format like "8:orgid:aadObjectId"
          const aadMatch = mriValue.match(/8:orgid:(.+)/);
          const quotedFrom = aadMatch ? aadMatch[1] : mriValue;
          const quotedText = htmlToText(previewMatch[1].trim());
          if (quotedText) {
            return { quotedFrom, quotedText };
          }
        }
      }
    }
  }

  return null;
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * Extract and remove Skype Reply blockquote from HTML content.
 * Teams wraps quoted replies in <blockquote itemtype="http://schema.skype.com/Reply">.
 */
export function extractReplyBlockquote(html) {
  if (!html) return { html: '', quote: null };
  const match = html.match(/<blockquote[^>]*itemtype=["']http:\/\/schema\.skype\.com\/Reply["'][^>]*>[\s\S]*?<\/blockquote>/i);
  if (!match) return { html, quote: null };
  const cleanHtml = html.replace(match[0], '').trim();
  const quote = htmlToText(match[0]);
  return { html: cleanHtml, quote };
}
