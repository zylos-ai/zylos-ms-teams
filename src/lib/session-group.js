/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * One group per conversation as Teams reports it, derived from the reply
 * endpoint (`<conversationId>|type:<dm|group|channel>|...`):
 *   personal chat              -> dm-<conversation id>
 *   group chat                 -> group-<conversation id>
 *   channel post (reply chain) -> channel-<conversation id>  (id carries ;messageid=)
 *   admin|type:dm-pairing      -> admin
 * To group a whole channel instead of each post, change only `conversationKey`
 * (e.g. strip `;messageid=...`); names are fixed once live, so plan that with Core.
 *
 * Core accepts [A-Za-z0-9_.:-], so the id is escaped reversibly: `_` -> `__`,
 * `@` `;` `=` `/` `+` `,` -> `_a` `_s` `_e` `_f` `_p` `_c`, any other byte ->
 * `_xHH`. When the name would exceed 95 characters, a short local id
 * `<prefix>-_<n>` is assigned once and kept in `session-groups.json`
 * (escaped names never contain `_<digit>`, so the two forms cannot collide).
 * Never truncated or hashed. Core prefixes the namespace; never add it here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { writeJsonAtomic } from './atomic-write.js';

/** Core's limits for the name a component passes (Core adds `<namespace>:`). */
export const SESSION_GROUP_MAX_LENGTH = 95;
export const SESSION_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
export const SESSION_GROUP_STORE = path.join(DATA_DIR, 'session-groups.json');

const PREFIX = { dm: 'dm', group: 'group', channel: 'channel' };
const ESCAPES = { '_': '__', '@': '_a', ';': '_s', '=': '_e', '/': '_f', '+': '_p', ',': '_c' };

/**
 * Whether Core would accept this nonempty name.
 * @param {string} name
 * @returns {boolean}
 */
export function isValidSessionGroup(name) {
  return typeof name === 'string' && name.length <= SESSION_GROUP_MAX_LENGTH
    && SESSION_GROUP_PATTERN.test(name);
}

export function parseEndpoint(endpoint) {
  const parts = String(endpoint ?? '').split('|');
  const result = { conversationId: parts[0] };
  for (const part of parts.slice(1)) {
    const idx = part.indexOf(':');
    if (idx > 0) result[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return result;
}

export function escapeId(id) {
  let out = '';
  for (const ch of String(id)) {
    if (/[A-Za-z0-9.:-]/.test(ch)) out += ch;
    else if (ESCAPES[ch]) out += ESCAPES[ch];
    else for (const b of Buffer.from(ch, 'utf8')) out += `_x${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function unescapeId(escaped) {
  const reverse = Object.fromEntries(Object.entries(ESCAPES).map(([k, v]) => [v[1], k]));
  const bytes = [];
  const flush = (s) => { for (const b of Buffer.from(s, 'utf8')) bytes.push(b); };
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped[i];
    if (ch !== '_') { flush(ch); continue; }
    const next = escaped[i + 1];
    if (next === 'x') { bytes.push(parseInt(escaped.slice(i + 2, i + 4), 16)); i += 3; continue; }
    if (next === '_') { flush('_'); i += 1; continue; }
    if (!reverse[next]) throw new Error(`invalid escape at ${i}`);
    flush(reverse[next]); i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The conversation a group stands for. Change here to regroup by channel. */
function conversationKey(ep) {
  return ep.conversationId;
}

function readStore(storePath) {
  try {
    const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (data && typeof data.ids === 'object' && Number.isInteger(data.next)) return data;
  } catch { /* missing or unreadable: empty store */ }
  return { ids: {}, next: 1 };
}

/**
 * Derive the session group for a reply endpoint.
 * @param {string} endpoint
 * @param {object} [opts]
 * @param {boolean} [opts.create=false] - assign a short id for a long, unseen
 *   conversation (receiver only); lookups never create
 * @param {string} [opts.storePath]
 * @returns {string} group name (never '')
 * @throws {Error} invalid endpoint, or long conversation with no stored id
 */
export function sessionGroupFromEndpoint(endpoint, { create = false, storePath = SESSION_GROUP_STORE } = {}) {
  const ep = parseEndpoint(endpoint);
  if (ep.conversationId === 'admin' && ep.type === 'dm-pairing') return 'admin';
  const prefix = PREFIX[ep.type];
  if (!prefix) throw new Error(`invalid Teams endpoint type: ${JSON.stringify(String(ep.type ?? '').slice(0, 32))}`);
  const key = conversationKey(ep);
  if (!key) throw new Error('invalid Teams endpoint: missing conversation id');

  const name = `${prefix}-${escapeId(key)}`;
  if (isValidSessionGroup(name)) return name;

  const storeKey = `${prefix}|${key}`;
  const store = readStore(storePath);
  if (store.ids[storeKey]) return store.ids[storeKey];
  if (!create) throw new Error(`no session group stored for this long ${prefix} conversation`);
  const short = `${prefix}-_${store.next}`;
  store.ids[storeKey] = short;
  store.next += 1;
  writeJsonAtomic(storePath, store, 0o600);
  return short;
}
