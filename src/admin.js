#!/usr/bin/env node
/**
 * zylos-teams admin CLI
 * Manage Microsoft Teams bot configuration
 *
 * Usage: node admin.js <command> [args]
 */

import dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { loadConfig, saveConfig, getCredentials } from './lib/config.js';
import { getAuthenticatedUsers, revokeAuth, buildAuthUrl } from './lib/delegated-auth.js';

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
      const mode = `, mode: ${cfg.mode || 'mention'}`;
      const allowFrom = cfg.allowFrom?.length ? ` allowFrom: [${cfg.allowFrom.join(', ')}]` : '';
      console.log(`  ${conversationId} - ${cfg.name || 'unnamed'}${mode}${allowFrom}`);
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

  'set-group-mode': (conversationId, mode) => {
    const valid = ['smart', 'mention'];
    mode = String(mode || '').trim().toLowerCase();
    if (!conversationId || !valid.includes(mode)) {
      console.error(`Usage: admin.js set-group-mode <conversation_id> <${valid.join('|')}>`);
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups?.[conversationId]) {
      console.error(`Group ${conversationId} not found. Add it first with add-group.`);
      process.exit(1);
    }
    if (mode === 'mention') {
      delete config.groups[conversationId].mode;
    } else {
      config.groups[conversationId].mode = mode;
    }
    saveConfigOrExit(config);
    console.log(`Group "${config.groups[conversationId].name}" mode set to: ${mode}`);
    console.log('Run: pm2 restart zylos-teams');
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

  'add-channel': (channelId, teamId, name) => {
    if (!channelId || !teamId || !name) {
      console.error('Usage: admin.js add-channel <channelId> <teamId> <name>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.channels) config.channels = {};

    if (config.channels[channelId]) {
      console.log(`Channel ${channelId} already configured, updating`);
    }

    config.channels[channelId] = {
      ...config.channels[channelId],
      name,
      teamId,
      mode: config.channels[channelId]?.mode || 'mention',
      allowFrom: config.channels[channelId]?.allowFrom ?? [],
      posts: config.channels[channelId]?.posts ?? {},
    };
    saveConfigOrExit(config);
    console.log(`Added channel: ${channelId} (${name}), team: ${teamId}`);
    console.log('Run: pm2 restart zylos-teams');
  },

  'remove-channel': (channelId) => {
    if (!channelId) {
      console.error('Usage: admin.js remove-channel <channelId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.channels?.[channelId]) {
      console.log(`Channel ${channelId} not found`);
      return;
    }
    const name = config.channels[channelId].name;
    delete config.channels[channelId];
    saveConfigOrExit(config);
    console.log(`Removed channel: ${channelId} (${name})`);
    console.log('Run: pm2 restart zylos-teams');
  },

  'list-channels': () => {
    const config = loadConfig();
    const channels = config.channels || {};
    const entries = Object.entries(channels);

    if (entries.length === 0) {
      console.log('No channels configured');
      return;
    }

    console.log(`Channels (${entries.length}):`);
    for (const [chId, chCfg] of entries) {
      const mode = chCfg.mode || 'mention';
      const allow = chCfg.allowFrom?.length ? `allowFrom: [${chCfg.allowFrom.join(', ')}]` : '';
      const posts = Object.keys(chCfg.posts || {}).length;
      const postsStr = posts > 0 ? `posts: ${posts}` : '';
      console.log(`  ${chId}`);
      console.log(`    name: ${chCfg.name || 'unnamed'}, team: ${chCfg.teamId || 'unknown'}, mode: ${mode} ${[allow, postsStr].filter(Boolean).join(', ')}`);
    }
  },

  'set-channel-mode': (channelId, mode) => {
    const valid = ['smart', 'mention'];
    mode = String(mode || '').trim().toLowerCase();
    if (!channelId || !valid.includes(mode)) {
      console.error(`Usage: admin.js set-channel-mode <channelId> <${valid.join('|')}>`);
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.channels?.[channelId]) {
      console.error(`Channel ${channelId} not found. Add it first with add-channel.`);
      process.exit(1);
    }
    config.channels[channelId].mode = mode;
    saveConfigOrExit(config);
    console.log(`Channel "${config.channels[channelId].name}" mode set to: ${mode}`);
    console.log('Run: pm2 restart zylos-teams');
  },

  'graph-status': () => {
    const creds = getCredentials();
    const hasGraph = !!(creds.appId && creds.appPassword && creds.tenantId);
    console.log(`Graph API: ${hasGraph ? 'enabled' : 'disabled'}`);
    console.log(`  App ID: ${creds.appId ? 'configured' : 'MISSING'}`);
    console.log(`  App Password: ${creds.appPassword ? 'configured' : 'MISSING'}`);
    console.log(`  Tenant ID: ${creds.tenantId ? creds.tenantId : 'MISSING (required for Graph)'}`);
    if (!hasGraph) {
      console.log('\nTo enable Graph API, add MSTEAMS_TENANT_ID to ~/zylos/.env');
    }
  },

  'auth-status': () => {
    const users = getAuthenticatedUsers();
    if (users.length === 0) {
      console.log('No delegated auth tokens stored.');
      console.log('Use auth-url to generate a sign-in link.');
      return;
    }
    console.log(`Delegated Auth Users (${users.length}):`);
    for (const u of users) {
      const expires = new Date(u.expiresAt).toISOString();
      const status = Date.now() < u.expiresAt ? 'active' : 'needs refresh';
      console.log(`  ${u.displayName} (${u.aadObjectId}) — ${status}, expires ${expires}`);
    }
  },

  'auth-url': (baseUrl) => {
    if (!baseUrl) {
      console.error('Usage: admin.js auth-url <base-url>');
      console.error('Example: admin.js auth-url https://your-domain.ngrok-free.dev');
      process.exit(1);
    }
    const redirectUri = `${baseUrl.replace(/\/$/, '')}/auth/callback`;
    try {
      const { url } = buildAuthUrl(redirectUri);
      console.log('Sign-in URL (send to user):');
      console.log(url);
      console.log(`\nRedirect URI (must be registered in Azure AD): ${redirectUri}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  },

  'auth-revoke': (aadObjectId) => {
    if (!aadObjectId) {
      console.error('Usage: admin.js auth-revoke <aad_object_id>');
      process.exit(1);
    }
    if (revokeAuth(aadObjectId)) {
      console.log(`Revoked delegated auth for ${aadObjectId}`);
    } else {
      console.log(`No auth found for ${aadObjectId}`);
    }
  },

  'help': () => {
    console.log(`
zylos-teams admin CLI

Commands:
  show                                Show full config

  Group Chat Management:
  list-groups                         List all configured group chats
  add-group <conversation_id> <name>  Add a group chat
  remove-group <conversation_id>      Remove a group chat
  set-group-mode <conv_id> <mode>     Set group chat mode (smart|mention)
  set-group-policy <policy>           Set group policy (disabled|allowlist|open)

  Channel Management:
  list-channels                       List all configured channels
  add-channel <chId> <teamId> <name>  Add a channel
  remove-channel <chId>               Remove a channel
  set-channel-mode <chId> <mode>      Set channel mode (smart|mention)

  DM Access Control:
  set-dm-policy <open|allowlist|owner> Set DM policy
  list-dm-allow                       Show DM policy and allowFrom list
  add-dm-allow <aad_object_id>        Add user to dmAllowFrom
  remove-dm-allow <aad_object_id>     Remove user from dmAllowFrom

  show-owner                          Show current owner

  Graph API:
  graph-status                        Show Graph API configuration status

  Delegated Auth (reactions):
  auth-status                         Show delegated auth users
  auth-url <base-url>                 Generate sign-in URL
  auth-revoke <aad_object_id>         Revoke delegated auth for a user

Permission flow:
  Private DM:  dmPolicy (open|allowlist|owner) + dmAllowFrom
  Group chat:  groupPolicy -> groups config
  Channel:     groupPolicy -> channels config -> posts (future)
  Owner always bypasses all checks.

After changes, restart: pm2 restart zylos-teams
`);
  }
};

const args = process.argv.slice(2);
const command = args[0] || 'help';

if (commands[command]) {
  commands[command](...args.slice(1));
  process.exit(0);
} else {
  console.error(`Unknown command: ${command}`);
  commands.help();
  process.exit(1);
}
