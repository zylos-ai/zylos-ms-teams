#!/usr/bin/env node
/**
 * zylos-teams admin CLI
 * Manage Microsoft Teams bot configuration
 *
 * Usage: node admin.js <command> [args]
 */

import { loadConfig, saveConfig } from './lib/config.js';

const VALID_GROUP_POLICIES = new Set(['disabled', 'allowlist', 'open']);

function getGroupsMap(config) {
  return config.groups || {};
}

function saveConfigOrExit(config) {
  if (saveConfig(config)) return true;
  console.error('Failed to save config');
  process.exit(1);
}

const commands = {
  'show': () => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  },

  'list-groups': () => {
    const config = loadConfig();
    const groups = getGroupsMap(config);
    const entries = Object.entries(groups);

    if (entries.length === 0) {
      console.log('No groups configured');
      return;
    }

    console.log(`Group Policy: ${config.groupPolicy || 'allowlist'}`);
    console.log(`\nConfigured Groups (${entries.length}):`);
    for (const [conversationId, cfg] of entries) {
      const allowFrom = cfg.allowFrom?.length ? ` allowFrom: [${cfg.allowFrom.join(', ')}]` : '';
      console.log(`  ${conversationId} - ${cfg.name || 'unnamed'}${allowFrom}`);
    }
  },

  'add-group': (conversationId, name) => {
    if (!conversationId || !name) {
      console.error('Usage: admin.js add-group <conversation_id> <name>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups) config.groups = {};

    if (config.groups[conversationId]) {
      console.log(`Group ${conversationId} already configured, updating name`);
      config.groups[conversationId].name = name;
    } else {
      config.groups[conversationId] = {
        name,
        allowFrom: [],
        added_at: new Date().toISOString()
      };
    }
    saveConfigOrExit(config);
    console.log(`Added group: ${conversationId} (${name})`);
    console.log('Run: pm2 restart zylos-teams');
  },

  'remove-group': (conversationId) => {
    if (!conversationId) {
      console.error('Usage: admin.js remove-group <conversation_id>');
      process.exit(1);
    }
    const config = loadConfig();

    if (config.groups?.[conversationId]) {
      const name = config.groups[conversationId].name;
      delete config.groups[conversationId];
      saveConfigOrExit(config);
      console.log(`Removed group: ${conversationId} (${name})`);
      console.log('Run: pm2 restart zylos-teams');
    } else {
      console.log(`Group ${conversationId} not found`);
    }
  },

  'set-group-policy': (policy) => {
    const normalizedPolicy = String(policy || '').trim().toLowerCase();
    if (!VALID_GROUP_POLICIES.has(normalizedPolicy)) {
      console.error(`Invalid policy "${policy || ''}". Valid values: disabled, allowlist, open.`);
      console.error('Usage: admin.js set-group-policy <disabled|allowlist|open>');
      process.exit(1);
    }
    const config = loadConfig();
    config.groupPolicy = normalizedPolicy;
    saveConfigOrExit(config);
    console.log(`Group policy set to: ${normalizedPolicy}`);
    console.log('Run: pm2 restart zylos-teams');
  },

  'set-dm-policy': (policy) => {
    const valid = ['open', 'allowlist', 'owner'];
    policy = String(policy || '').trim().toLowerCase();
    if (!valid.includes(policy)) {
      console.error(`Usage: admin.js set-dm-policy <${valid.join('|')}>`);
      process.exit(1);
    }
    const config = loadConfig();
    config.dmPolicy = policy;
    saveConfigOrExit(config);
    const desc = { open: 'Anyone can DM', allowlist: 'Only dmAllowFrom users can DM', owner: 'Only owner can DM' };
    console.log(`DM policy set to: ${policy} (${desc[policy]})`);
    console.log('Run: pm2 restart zylos-teams');
  },

  'list-dm-allow': () => {
    const config = loadConfig();
    console.log(`DM policy: ${config.dmPolicy || 'owner'}`);
    console.log(`Group policy: ${config.groupPolicy || 'allowlist'}`);
    const allowFrom = config.dmAllowFrom || [];
    console.log(`DM allowFrom (${allowFrom.length}):`, allowFrom.length ? allowFrom.join(', ') : 'none');
  },

  'add-dm-allow': (userId) => {
    if (!userId) {
      console.error('Usage: admin.js add-dm-allow <aad_object_id>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) {
      config.dmAllowFrom = [];
    }
    if (!config.dmAllowFrom.includes(userId)) {
      config.dmAllowFrom.push(userId);
    }
    saveConfigOrExit(config);
    console.log(`Added ${userId} to dmAllowFrom`);
    if ((config.dmPolicy || 'owner') !== 'allowlist') {
      console.log(`Note: dmPolicy is "${config.dmPolicy || 'owner'}", set to "allowlist" for this to take effect.`);
    }
    console.log('Run: pm2 restart zylos-teams');
  },

  'remove-dm-allow': (userId) => {
    if (!userId) {
      console.error('Usage: admin.js remove-dm-allow <aad_object_id>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) {
      console.log('No dmAllowFrom configured');
      return;
    }
    const idx = config.dmAllowFrom.indexOf(userId);
    if (idx !== -1) {
      config.dmAllowFrom.splice(idx, 1);
      saveConfigOrExit(config);
      console.log(`Removed ${userId} from dmAllowFrom`);
    } else {
      console.log(`${userId} not found in dmAllowFrom`);
    }
  },

  'show-owner': () => {
    const config = loadConfig();
    const owner = config.owner || {};
    if (owner.bound) {
      console.log(`Owner: ${owner.name || 'unknown'}`);
      console.log(`  aadObjectId: ${owner.aadObjectId}`);
    } else {
      console.log('No owner bound (first DM sender will become owner)');
    }
  },

  'help': () => {
    console.log(`
zylos-teams admin CLI

Commands:
  show                                Show full config

  Group Management:
  list-groups                         List all configured groups
  add-group <conversation_id> <name>  Add a group
  remove-group <conversation_id>      Remove a group
  set-group-policy <policy>           Set group policy (disabled|allowlist|open)

  DM Access Control:
  set-dm-policy <open|allowlist|owner> Set DM policy
  list-dm-allow                       Show DM policy and allowFrom list
  add-dm-allow <aad_object_id>        Add user to dmAllowFrom
  remove-dm-allow <aad_object_id>     Remove user from dmAllowFrom

  show-owner                          Show current owner

Permission flow:
  Private DM:  dmPolicy (open|allowlist|owner) + dmAllowFrom
  Group chat:  groupPolicy -> groups config
  Owner always bypasses all checks.

After changes, restart: pm2 restart zylos-teams
`);
  }
};

const args = process.argv.slice(2);
const command = args[0] || 'help';

if (commands[command]) {
  commands[command](...args.slice(1));
} else {
  console.error(`Unknown command: ${command}`);
  commands.help();
  process.exit(1);
}
