#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-teams
 *
 * Called by Claude after CLI upgrade completes.
 * CLI handles: stop service, backup, file sync, npm install, manifest.
 *
 * This hook handles component-specific migrations:
 * - Config schema migrations
 *
 * Note: Service restart is handled by Claude after this hook.
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/teams');
const configPath = path.join(DATA_DIR, 'config.json');

console.log('[post-upgrade] Running teams-specific migrations...\n');

if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let migrated = false;
    const migrations = [];

    // Migration 1: Ensure enabled field
    if (config.enabled === undefined) {
      config.enabled = true;
      migrated = true;
      migrations.push('Added enabled field');
    }

    // Migration 2: Ensure port
    if (config.port === undefined) {
      config.port = 3978;
      migrated = true;
      migrations.push('Added port');
    }

    // Migration 3: Ensure owner structure
    if (!config.owner) {
      config.owner = { bound: false, aadObjectId: '', name: '' };
      migrated = true;
      migrations.push('Added owner structure');
    }

    // Migration 4: Ensure dmPolicy/dmAllowFrom
    if (config.dmPolicy === undefined) {
      config.dmPolicy = 'owner';
      migrated = true;
      migrations.push('Added dmPolicy');
    }
    if (config.dmAllowFrom === undefined) {
      config.dmAllowFrom = [];
      migrated = true;
      migrations.push('Added dmAllowFrom');
    }

    // Migration 5: Ensure groupPolicy/groups
    if (config.groupPolicy === undefined) {
      config.groupPolicy = 'allowlist';
      migrated = true;
      migrations.push('Added groupPolicy');
    }
    if (config.groups === undefined) {
      config.groups = {};
      migrated = true;
      migrations.push('Added groups map');
    }

    // Migration 6: Ensure message settings
    if (!config.message) {
      config.message = { context_messages: 10 };
      migrated = true;
      migrations.push('Added message settings');
    }

    if (migrated) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('Config migrations applied:');
      migrations.forEach(m => console.log('  - ' + m));
    } else {
      console.log('No config migrations needed.');
    }
  } catch (err) {
    console.error('Config migration failed:', err.message);
    process.exit(1);
  }
} else {
  console.log('No config file found, skipping migrations.');
}

console.log('\n[post-upgrade] Complete!');
