#!/usr/bin/env node
/**
 * Post-install hook for zylos-msteams
 *
 * This hook handles msteams-specific setup:
 * - Create subdirectories (logs, media, data)
 * - Create default config.json
 * - Check for environment variables
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/msteams');
const ENV_FILE = path.join(HOME, 'zylos/.env');

const INITIAL_CONFIG = {
  enabled: true,
  port: 3978,
  dmPolicy: 'owner',
  groupPolicy: 'allowlist'
};

console.log('[post-install] Running msteams-specific setup...\n');

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

// 3. Check environment variables
console.log('\nChecking environment variables...');
let envContent = '';
try {
  envContent = fs.readFileSync(ENV_FILE, 'utf8');
} catch (e) {}

const hasAppId = envContent.includes('MSTEAMS_APP_ID');
const hasAppPassword = envContent.includes('MSTEAMS_APP_PASSWORD');

if (!hasAppId || !hasAppPassword) {
  console.log('  MSTEAMS_APP_ID and/or MSTEAMS_APP_PASSWORD not yet in .env.');
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
console.log('2. Add credentials to ~/zylos/.env:');
console.log('   MSTEAMS_APP_ID=your_app_id');
console.log('   MSTEAMS_APP_PASSWORD=your_app_password');
console.log('');

let webhookUrl = 'https://<your-domain>/msteams/api/messages';
try {
  const zylosConfig = JSON.parse(fs.readFileSync(path.join(HOME, 'zylos/.zylos/config.json'), 'utf8'));
  if (zylosConfig.domain) {
    const protocol = zylosConfig.protocol || 'https';
    webhookUrl = `${protocol}://${zylosConfig.domain}/msteams/api/messages`;
  }
} catch (e) {}

console.log('3. Set messaging endpoint in Azure Bot Registration:');
console.log(`   ${webhookUrl}`);
console.log('');
console.log('4. Install the bot in your Teams tenant');
console.log('');
console.log('First private message to the bot will auto-bind the sender as owner.');
console.log('========================================');
