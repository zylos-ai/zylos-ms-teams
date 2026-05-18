#!/usr/bin/env node
/**
 * Configure hook for zylos-ms-teams
 *
 * Called by zylos after collecting SKILL.md config.required values.
 * Receives a JSON object on stdin and writes component-owned config.json.
 *
 * Example stdin:
 *   { "MSTEAMS_APP_ID": "3aec5a58-...", "MSTEAMS_APP_PASSWORD": "secret" }
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/ms-teams');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ENV_PATH = path.join(HOME, 'zylos/.env');
const COMPONENT_PREFIX = 'MSTEAMS_';

const DEFAULT_CONFIG = {
  enabled: true,
  port: 3978,
  dmPolicy: 'owner',
  groupPolicy: 'allowlist'
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return { ...fallback };
    return { ...fallback, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${err.message}`);
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmpPath, filePath);
}

function appendEnvVar(name, value) {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch {}
  const re = new RegExp(`^${name}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${name}=${value}`);
  } else {
    content = content.trimEnd() + `\n${name}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, content);
}

try {
  const raw = (await readStdin()).trim();
  if (!raw) {
    throw new Error('Expected stdin JSON object with collected config values');
  }

  const collected = JSON.parse(raw);
  if (!collected || Array.isArray(collected) || typeof collected !== 'object') {
    throw new Error('Configure input must be a JSON object');
  }

  const config = readJsonFile(CONFIG_PATH, DEFAULT_CONFIG);

  for (const [name, value] of Object.entries(collected)) {
    if (value === undefined || value === null || value === '') continue;
    appendEnvVar(name, value);
  }

  writeJsonFile(CONFIG_PATH, config);
  console.log(`[configure] Credentials written to ${ENV_PATH}`);
  console.log(`[configure] Config written to ${CONFIG_PATH}`);
} catch (err) {
  console.error(`[configure] ${err.message}`);
  process.exit(1);
}
