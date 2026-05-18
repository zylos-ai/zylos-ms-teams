#!/usr/bin/env node
/**
 * C4 Communication Bridge Interface for zylos-teams
 *
 * Usage:
 *   ./send.js <endpoint> "message text"
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error
 */

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, DATA_DIR } from '../src/lib/config.js';
import { splitMarkdownMessage } from '../src/lib/markdown-split.js';

const MAX_LENGTH = 4000;

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: send.js <endpoint> <message>');
  process.exit(1);
}

const rawEndpoint = args[0];
const message = args.slice(1).join(' ');

const ENDPOINT_KEYS = new Set(['type', 'user', 'msg']);

function parseEndpoint(endpoint) {
  const parts = endpoint.split('|');
  const result = { conversationId: parts[0] };
  for (const part of parts.slice(1)) {
    const colonIdx = part.indexOf(':');
    if (colonIdx > 0) {
      const key = part.substring(0, colonIdx);
      if (!ENDPOINT_KEYS.has(key)) continue;
      const value = part.substring(colonIdx + 1);
      result[key] = value;
    }
  }
  return result;
}

const parsedEndpoint = parseEndpoint(rawEndpoint);

if (message.trim() === '[SKIP]') {
  process.exit(0);
}

const config = getConfig();
if (!config.enabled) {
  console.error('Error: teams is disabled in config');
  process.exit(1);
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      const finalChunk = remaining.trim();
      if (finalChunk.length > 0) {
        chunks.push(finalChunk);
      }
      break;
    }

    let breakAt = maxLength;
    const segment = remaining.substring(0, breakAt);
    const fenceMatches = segment.match(/```/g);
    const insideCodeBlock = fenceMatches && fenceMatches.length % 2 !== 0;

    if (insideCodeBlock) {
      const lastFenceStart = segment.lastIndexOf('```');
      const lineBeforeFence = remaining.lastIndexOf('\n', lastFenceStart - 1);
      if (lineBeforeFence > maxLength * 0.2) {
        breakAt = lineBeforeFence;
      } else {
        const fenceEnd = remaining.indexOf('```', lastFenceStart + 3);
        if (fenceEnd !== -1) {
          const blockEnd = remaining.indexOf('\n', fenceEnd + 3);
          breakAt = blockEnd !== -1 ? blockEnd + 1 : fenceEnd + 3;
        }
        if (breakAt > maxLength) {
          breakAt = maxLength;
        }
      }
    } else {
      const chunk = remaining.substring(0, breakAt);
      const lastParaBreak = chunk.lastIndexOf('\n\n');
      if (lastParaBreak > maxLength * 0.3) {
        breakAt = lastParaBreak + 1;
      } else {
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline > maxLength * 0.3) {
          breakAt = lastNewline;
        } else {
          const lastSpace = chunk.lastIndexOf(' ');
          if (lastSpace > maxLength * 0.3) {
            breakAt = lastSpace;
          }
        }
      }
    }

    const nextChunk = remaining.substring(0, breakAt).trim();
    if (nextChunk.length > 0) {
      chunks.push(nextChunk);
    }
    remaining = remaining.substring(breakAt).trim();
  }

  return chunks;
}

function readInternalToken() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, '.internal-token'), 'utf8').trim();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendViaInternal(conversationId, text, { replyToId } = {}) {
  const internalToken = readInternalToken();
  if (!internalToken) {
    throw new Error('Internal token not found. Is the teams service running?');
  }

  const port = config.port || 3978;
  const payload = {
    conversationId,
    text,
    type: parsedEndpoint.type || 'dm'
  };
  if (replyToId) payload.replyToId = replyToId;

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': internalToken
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
        console.warn(`[teams] Rate limited, retrying in ${retryAfter}s`);
        clearTimeout(timeout);
        await sleep(retryAfter * 1000);
        continue;
      }

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

const MEDIA_PREFIXES = ['[MEDIA:image]', '[MEDIA:file]'];

function parseMediaPrefix(text) {
  for (const prefix of MEDIA_PREFIXES) {
    if (text.startsWith(prefix)) {
      const mediaType = prefix === '[MEDIA:image]' ? 'image' : 'file';
      const filePath = text.slice(prefix.length).trim();
      return { mediaType, filePath };
    }
  }
  return null;
}

async function sendMedia(mediaType, filePath) {
  const { conversationId } = parsedEndpoint;
  const internalToken = readInternalToken();
  if (!internalToken) {
    throw new Error('Internal token not found. Is the teams service running?');
  }

  const port = config.port || 3978;
  const body = JSON.stringify({
    conversationId,
    mediaType,
    filePath,
    type: parsedEndpoint.type || 'dm'
  });

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/send-media`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': internalToken
        },
        body,
        signal: controller.signal
      });

      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
        console.warn(`[teams] Rate limited on media send, retrying in ${retryAfter}s`);
        clearTimeout(timeout);
        await sleep(retryAfter * 1000);
        continue;
      }

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function sendText(text) {
  const chunks = splitMarkdownMessage(text, MAX_LENGTH);
  const { conversationId } = parsedEndpoint;
  const triggerMsgId = parsedEndpoint.msg || null;

  for (let i = 0; i < chunks.length; i++) {
    const opts = {};
    // Reply-to: first chunk chains to trigger message
    if (i === 0 && triggerMsgId) opts.replyToId = triggerMsgId;
    await sendViaInternal(conversationId, chunks[i], opts);
    if (i < chunks.length - 1) {
      await sleep(500);
    }
  }

  if (chunks.length > 1) {
    console.log(`Sent ${chunks.length} chunks`);
  }
}

async function removeThinkingReaction() {
  const triggerMsgId = parsedEndpoint.msg;
  if (!triggerMsgId) return;
  const internalToken = readInternalToken();
  if (!internalToken) return;
  const port = config.port || 3978;
  try {
    await fetch(`http://127.0.0.1:${port}/internal/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': internalToken },
      body: JSON.stringify({
        conversationId: parsedEndpoint.conversationId,
        messageId: triggerMsgId,
        reactionType: '💬',
        conversationType: parsedEndpoint.type || 'dm',
        action: 'remove',
      }),
    });
  } catch {}
}

async function send() {
  try {
    const media = parseMediaPrefix(message);
    if (media) {
      await sendMedia(media.mediaType, media.filePath);
    } else {
      await sendText(message);
    }
    await removeThinkingReaction();
    console.log('Message sent successfully');
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

send();
