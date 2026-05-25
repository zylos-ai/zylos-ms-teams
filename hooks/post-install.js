#!/usr/bin/env node
/**
 * Post-install hook for zylos-ms-teams
 *
 * This hook handles teams-specific setup:
 * - Create subdirectories (logs, media, data)
 * - Create default config.json
 * - Check for environment variables
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/ms-teams');

const INITIAL_CONFIG = {
  enabled: true,
  port: 3978,
  dmPolicy: 'owner',
  groupPolicy: 'allowlist'
};

console.log('[post-install] Running teams-specific setup...\n');

// 1. Create subdirectories
console.log('Creating subdirectories...');
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'data'), { recursive: true });
console.log('  - logs/');
console.log('  - media/');
console.log('  - data/');

// 2. Create default config if not exists
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  console.log('\nCreating default config.json...');
  fs.writeFileSync(configPath, JSON.stringify(INITIAL_CONFIG, null, 2));
  console.log('  - config.json created');
} else {
  console.log('\nConfig already exists, skipping.');
}

// 3. Check credentials in config
console.log('\nChecking credentials...');
let hasCredentials = false;
try {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  hasCredentials = !!(cfg.credentials?.appId && cfg.credentials?.appPassword);
} catch {}

if (!hasCredentials) {
  // Fallback: check legacy .env
  let envContent = '';
  try { envContent = fs.readFileSync(path.join(HOME, 'zylos/.env'), 'utf8'); } catch {}
  hasCredentials = envContent.includes('MSTEAMS_APP_ID') && envContent.includes('MSTEAMS_APP_PASSWORD');
}

if (!hasCredentials) {
  console.log('  Credentials not yet configured. Run the configure hook or use the admin CLI.');
} else {
  console.log('  Credentials found.');
}

console.log('\n[post-install] Complete!');

console.log('\n========================================');
console.log('  Microsoft Teams Setup - Remaining Steps');
console.log('========================================');
console.log('');
console.log('1. Create an Azure Bot Registration:');
console.log('   https://portal.azure.com -> Bot Services -> Create');
console.log('');
console.log('2. Run the configure hook to set credentials:');
console.log('   zylos configure ms-teams');
console.log('   (stores credentials in config.json — legacy .env values are also read as fallback)');
console.log('');

let webhookUrl = 'https://<your-domain>/ms-teams/api/messages';
try {
  const zylosConfig = JSON.parse(fs.readFileSync(path.join(HOME, 'zylos/.zylos/config.json'), 'utf8'));
  if (zylosConfig.domain) {
    const protocol = zylosConfig.protocol || 'https';
    webhookUrl = `${protocol}://${zylosConfig.domain}/ms-teams/api/messages`;
  }
} catch (e) {}

console.log('3. Set messaging endpoint in Azure Bot Registration:');
console.log(`   ${webhookUrl}`);
console.log('');
console.log('4. Install the bot in your Teams tenant');
console.log('');
console.log('First private message to the bot will auto-bind the sender as owner.');
console.log('========================================');
