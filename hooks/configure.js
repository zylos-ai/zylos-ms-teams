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

  const credentialMap = {
    MSTEAMS_APP_ID: 'appId',
    MSTEAMS_APP_PASSWORD: 'appPassword',
    MSTEAMS_TENANT_ID: 'tenantId',
  };
  if (!config.credentials) config.credentials = {};

  for (const [name, value] of Object.entries(collected)) {
    if (value === undefined || value === null || value === '') continue;
    const configKey = credentialMap[name];
    if (configKey) {
      config.credentials[configKey] = value;
    } else if (name === 'MSTEAMS_PUBLIC_URL') {
      config.publicUrl = value;
    }
  }

  writeJsonFile(CONFIG_PATH, config);
  console.log(`[configure] Config written to ${CONFIG_PATH}`);
} catch (err) {
  console.error(`[configure] ${err.message}`);
  process.exit(1);
}
