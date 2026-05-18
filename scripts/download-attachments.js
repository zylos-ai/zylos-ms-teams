#!/usr/bin/env node
import dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { acquireTokenForScope } from '../src/lib/graph.js';
import { downloadGraphMedia } from '../src/lib/attachments.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

const args = process.argv.slice(2);

function usage() {
  console.error('Usage:');
  console.error('  download-attachments.js channel <teamId> <channelId> <messageId> [rootMessageId]');
  console.error('  download-attachments.js chat <chatId> <messageId>');
  process.exit(1);
}

if (args.length < 3) usage();

const type = args[0];
let messageUrls = [];

if (type === 'channel') {
  if (args.length < 4) usage();
  const [, teamId, channelId, messageId, rootMessageId] = args;
  const base = `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}`;
  if (rootMessageId) {
    messageUrls.push(`${base}/messages/${encodeURIComponent(rootMessageId)}/replies/${encodeURIComponent(messageId)}`);
  }
  messageUrls.push(`${base}/messages/${encodeURIComponent(messageId)}`);
} else if (type === 'chat') {
  if (args.length < 3) usage();
  const [, chatId, messageId] = args;
  messageUrls.push(`${GRAPH_BASE}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`);
} else {
  usage();
}

const tokenProvider = (scope) => acquireTokenForScope(scope);

try {
  const files = await downloadGraphMedia({ messageUrls, tokenProvider });
  if (files.length === 0) {
    console.log('No attachments found.');
  } else {
    for (const f of files) {
      console.log(f.path);
    }
  }
} catch (err) {
  console.error(`Download failed: ${err.message}`);
  process.exit(1);
}
