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
 * `<prefix>-_<n>` is assigned once and kept in `session-groups.json`. In an
 * escaped name every `_` starts a two-character escape (`__`, `_a`, `_x`...),
 * so at an escape boundary `_` is never followed by a digit; `<prefix>-_<n>`
 * therefore cannot equal any escaped name.
 * Never truncated or hashed. Core prefixes the namespace; never add it here.
 *
 * Short ids must never be reused (Core and the scheduler keep them): a
 * corrupt or structurally invalid store is an error (never treated as empty
 * or overwritten), every write also writes a durable `.bak` copy, a missing
 * store is restored from `.bak` when present, and new numbers start at
 * max(stored next, highest stored id + 1, current time in ms), so even after
 * the store is lost a new id cannot equal an earlier one.
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
    if (next === 'x') {
      const hex = escaped.slice(i + 2, i + 4);
      if (!/^[0-9A-F]{2}$/.test(hex)) throw new Error(`invalid escape at ${i}`);
      bytes.push(parseInt(hex, 16)); i += 3; continue;
    }
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

const SHORT_ID = /^(dm|group|channel)-_(\d+)$/;

function validateStore(data, source) {
  const ok = data !== null && typeof data === 'object' && !Array.isArray(data)
    && data.ids !== null && typeof data.ids === 'object' && !Array.isArray(data.ids)
    && Number.isSafeInteger(data.next) && data.next >= 1
    && Object.values(data.ids).every(v => typeof v === 'string' && SHORT_ID.test(v));
  if (!ok) throw new Error(`session group store ${source} is invalid; refusing to use or overwrite it`);
  const values = Object.values(data.ids);
  if (new Set(values).size !== values.length) {
    throw new Error(`session group store ${source} maps two conversations to one id; refusing to use it`);
  }
  return data;
}

function parseStoreFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`session group store ${file} is not valid JSON; refusing to use or overwrite it`);
  }
  return validateStore(data, file);
}

/**
 * Read the store. Only a missing file (with no backup) is an empty store;
 * anything unreadable or malformed throws and the file is left untouched.
 */
export function readStore(storePath) {
  try {
    return parseStoreFile(storePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    const restored = parseStoreFile(`${storePath}.bak`);
    console.warn(`[ms-teams] ${storePath} missing; using backup ${storePath}.bak`);
    return restored;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { ids: {}, next: 1 };
}

function nextNumber(store, now) {
  let max = 0;
  for (const v of Object.values(store.ids)) max = Math.max(max, Number(SHORT_ID.exec(v)[2]));
  return Math.max(store.next, max + 1, now);
}

/**
 * Derive the session group for a reply endpoint.
 * @param {string} endpoint
 * @param {object} [opts]
 * @param {boolean} [opts.create=false] - assign a short id for a long, unseen
 *   conversation (receiver only); lookups never create
 * @param {string} [opts.storePath]
 * @param {() => number} [opts.now] - clock for new short ids (tests)
 * @returns {string} group name (never '')
 * @throws {Error} invalid endpoint, long conversation with no stored id, or
 *   corrupt/invalid store (never overwritten)
 */
export function sessionGroupFromEndpoint(endpoint, { create = false, storePath = SESSION_GROUP_STORE, now = Date.now } = {}) {
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
  const n = nextNumber(store, now());
  const short = `${prefix}-_${n}`;
  store.ids[storeKey] = short;
  store.next = n + 1;
  // Backup first, both durable: if the main file is later lost, the backup
  // already holds every assigned id.
  writeJsonAtomic(`${storePath}.bak`, store, 0o600);
  writeJsonAtomic(storePath, store, 0o600);
  return short;
}
