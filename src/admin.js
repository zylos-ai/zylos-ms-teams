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

  'add-team': (teamId, name) => {
    if (!teamId || !name) {
      console.error('Usage: admin.js add-team <teamId> <name>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.teamOverrides) config.teamOverrides = {};

    if (config.teamOverrides[teamId]) {
      console.log(`Team ${teamId} already configured, updating name`);
    }

    config.teamOverrides[teamId] = {
      ...config.teamOverrides[teamId],
      name,
      requireMention: config.teamOverrides[teamId]?.requireMention ?? true,
      replyStyle: config.teamOverrides[teamId]?.replyStyle ?? 'thread',
      allowFrom: config.teamOverrides[teamId]?.allowFrom ?? [],
      channels: config.teamOverrides[teamId]?.channels ?? {},
    };
    saveConfigOrExit(config);
    console.log(`Added team: ${teamId} (${name})`);
    console.log('Run: pm2 restart zylos-teams');
  },

  'remove-team': (teamId) => {
    if (!teamId) {
      console.error('Usage: admin.js remove-team <teamId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.teamOverrides) config.teamOverrides = {};

    if (config.teamOverrides[teamId]) {
      const name = config.teamOverrides[teamId].name;
      delete config.teamOverrides[teamId];
      saveConfigOrExit(config);
      console.log(`Removed team: ${teamId} (${name})`);
      console.log('Run: pm2 restart zylos-teams');
    } else {
      console.log(`Team ${teamId} not found`);
    }
  },

  'set-team-mention': (teamId, value) => {
    if (!teamId || (value !== 'true' && value !== 'false')) {
      console.error('Usage: admin.js set-team-mention <teamId> <true|false>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.teamOverrides) config.teamOverrides = {};
    if (!config.teamOverrides[teamId]) {
      console.error(`Team ${teamId} not found. Add it first with add-team.`);
      process.exit(1);
    }
    config.teamOverrides[teamId].requireMention = value === 'true';
    saveConfigOrExit(config);
    console.log(`Team ${teamId} requireMention set to: ${value}`);
    console.log('Run: pm2 restart zylos-teams');
  },

  'add-channel': (teamId, channelId, name) => {
    if (!teamId || !channelId || !name) {
      console.error('Usage: admin.js add-channel <teamId> <channelId> <name>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.teamOverrides) config.teamOverrides = {};
    if (!config.teamOverrides[teamId]) {
      console.error(`Team ${teamId} not found. Add it first with add-team.`);
      process.exit(1);
    }
    if (!config.teamOverrides[teamId].channels) {
      config.teamOverrides[teamId].channels = {};
    }

    if (config.teamOverrides[teamId].channels[channelId]) {
      console.log(`Channel ${channelId} already configured, updating name`);
    }

    config.teamOverrides[teamId].channels[channelId] = {
      ...config.teamOverrides[teamId].channels[channelId],
      name,
      requireMention: config.teamOverrides[teamId].channels[channelId]?.requireMention,
      replyStyle: config.teamOverrides[teamId].channels[channelId]?.replyStyle,
      allowFrom: config.teamOverrides[teamId].channels[channelId]?.allowFrom ?? [],
    };
    saveConfigOrExit(config);
    console.log(`Added channel: ${channelId} (${name}) under team ${teamId}`);
    console.log('Run: pm2 restart zylos-teams');
  },

  'remove-channel': (teamId, channelId) => {
    if (!teamId || !channelId) {
      console.error('Usage: admin.js remove-channel <teamId> <channelId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.teamOverrides?.[teamId]?.channels?.[channelId]) {
      console.log(`Channel ${channelId} not found under team ${teamId}`);
      return;
    }
    const name = config.teamOverrides[teamId].channels[channelId].name;
    delete config.teamOverrides[teamId].channels[channelId];
    saveConfigOrExit(config);
    console.log(`Removed channel: ${channelId} (${name}) from team ${teamId}`);
    console.log('Run: pm2 restart zylos-teams');
  },

  'list-teams': () => {
    const config = loadConfig();
    const teams = config.teamOverrides || {};
    const entries = Object.entries(teams);

    if (entries.length === 0) {
      console.log('No team overrides configured');
      return;
    }

    console.log(`Team Overrides (${entries.length}):`);
    for (const [teamId, teamCfg] of entries) {
      const mention = teamCfg.requireMention !== undefined ? `requireMention: ${teamCfg.requireMention}` : '';
      const style = teamCfg.replyStyle ? `replyStyle: ${teamCfg.replyStyle}` : '';
      const allow = teamCfg.allowFrom?.length ? `allowFrom: [${teamCfg.allowFrom.join(', ')}]` : '';
      console.log(`  ${teamId} - ${teamCfg.name || 'unnamed'} ${[mention, style, allow].filter(Boolean).join(', ')}`);

      const channels = teamCfg.channels || {};
      for (const [chId, chCfg] of Object.entries(channels)) {
        const chMention = chCfg.requireMention !== undefined ? `requireMention: ${chCfg.requireMention}` : '';
        const chStyle = chCfg.replyStyle ? `replyStyle: ${chCfg.replyStyle}` : '';
        const chAllow = chCfg.allowFrom?.length ? `allowFrom: [${chCfg.allowFrom.join(', ')}]` : '';
        console.log(`    ${chId} - ${chCfg.name || 'unnamed'} ${[chMention, chStyle, chAllow].filter(Boolean).join(', ')}`);
      }
    }
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

  Group Management:
  list-groups                         List all configured groups
  add-group <conversation_id> <name>  Add a group
  remove-group <conversation_id>      Remove a group
  set-group-policy <policy>           Set group policy (disabled|allowlist|open)

  Team/Channel Overrides:
  list-teams                          List all team overrides and channels
  add-team <teamId> <name>            Add a team override
  remove-team <teamId>                Remove a team override
  set-team-mention <teamId> <bool>    Set requireMention for a team
  add-channel <teamId> <chId> <name>  Add a channel override under a team
  remove-channel <teamId> <chId>      Remove a channel override

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
  Group chat:  groupPolicy -> groups config -> teamOverrides -> channel overrides
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
