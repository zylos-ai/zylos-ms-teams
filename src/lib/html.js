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

  // Block-level elements that should produce line breaks
  // Insert newlines before/after block elements
  text = text.replace(/<\/(?:p|div|blockquote|h[1-6]|pre|ul|ol)>/gi, '\n');
  text = text.replace(/<(?:p|div|blockquote|h[1-6]|pre|ul|ol)(?:\s[^>]*)?>/gi, '\n');

  // <br> and <br/>
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // <li> -> bullet point
  text = text.replace(/<li(?:\s[^>]*)?>/gi, '\n- ');
  text = text.replace(/<\/li>/gi, '');

  // <a href="url">text</a> -> text (url)
  text = text.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, (_, href, linkText) => {
    const cleanLink = linkText.replace(/<[^>]+>/g, '').trim();
    if (!cleanLink || cleanLink === href) return href;
    return `${cleanLink} (${href})`;
  });

  // <pre><code>...</code></pre> -> preserve content with backticks
  text = text.replace(/<pre(?:\s[^>]*)?>\s*<code(?:\s[^>]*)?>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code) => {
    return '\n```\n' + code.replace(/<[^>]+>/g, '') + '\n```\n';
  });

  // <pre>...</pre> -> preserve content
  text = text.replace(/<pre(?:\s[^>]*)?>([\s\S]*?)<\/pre>/gi, (_, code) => {
    return '\n```\n' + code.replace(/<[^>]+>/g, '') + '\n```\n';
  });

  // Inline <code>...</code>
  text = text.replace(/<code(?:\s[^>]*)?>(.*?)<\/code>/gi, '`$1`');

  // Bold/italic — extract content
  text = text.replace(/<(?:b|strong)(?:\s[^>]*)?>(.*?)<\/(?:b|strong)>/gi, '$1');
  text = text.replace(/<(?:i|em)(?:\s[^>]*)?>(.*?)<\/(?:i|em)>/gi, '$1');

  // <at>...</at> — Teams mention tags, keep inner text
  text = text.replace(/<at(?:\s[^>]*)?>(.*?)<\/at>/gi, '$1');

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
  }

  return null;
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}
