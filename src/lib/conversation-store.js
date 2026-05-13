import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/msteams');
const STORE_PATH = path.join(DATA_DIR, 'conversations.json');

let references = null;

function load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      references = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } else {
      references = {};
    }
  } catch (err) {
    console.error(`[msteams] Failed to load conversation store: ${err.message}`);
    references = {};
  }
  return references;
}

function save() {
  const tmpPath = STORE_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(references, null, 2));
    fs.renameSync(tmpPath, STORE_PATH);
    return true;
  } catch (err) {
    console.error(`[msteams] Failed to save conversation store: ${err.message}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return false;
  }
}

export function getConversationReference(conversationId) {
  if (!references) load();
  return references[conversationId] || null;
}

export function saveConversationReference(conversationId, reference) {
  if (!references) load();
  references[conversationId] = reference;
  return save();
}

export function removeConversationReference(conversationId) {
  if (!references) load();
  if (references[conversationId]) {
    delete references[conversationId];
    return save();
  }
  return true;
}

export function getAllConversationReferences() {
  if (!references) load();
  return { ...references };
}
