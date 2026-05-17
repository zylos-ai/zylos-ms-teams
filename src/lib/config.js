import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/teams');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  enabled: true,
  port: 3978,
  owner: {
    bound: false,
    aadObjectId: '',
    name: ''
  },
  dmPolicy: 'owner',
  dmAllowFrom: [],
  groupPolicy: 'allowlist',
  groups: {},
  teamOverrides: {},
  message: {
    context_messages: 10
  }
};

let config = null;
let configWatcher = null;
let configReloadTimer = null;

export function mergeConfigWithDefaults(parsed = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    owner: {
      ...DEFAULT_CONFIG.owner,
      ...(parsed.owner || {})
    },
    teamOverrides: parsed.teamOverrides || {},
    message: {
      ...DEFAULT_CONFIG.message,
      ...(parsed.message || {})
    }
  };
}

/**
 * Resolve route-level configuration for an activity by walking:
 *   global defaults -> team override -> channel override
 *
 * Each level can set: requireMention, replyStyle, allowFrom
 *
 * @param {object} activity - The Teams activity
 * @param {object} config - The loaded config
 * @returns {{ requireMention: boolean, replyStyle: string, allowFrom: string[] }}
 */
export function resolveRouteConfig(activity, config) {
  // Global defaults
  const result = {
    requireMention: true,
    replyStyle: 'top-level',
    allowFrom: [],
  };

  const teamId = activity.channelData?.team?.id
    || activity.channelData?.teamsTeamId
    || activity.team?.id
    || '';
  const conversationId = activity.conversation?.id || '';

  // Apply group-level allowFrom from config.groups
  const groupConfig = (config.groups || {})[conversationId];
  if (groupConfig && Array.isArray(groupConfig.allowFrom) && groupConfig.allowFrom.length > 0) {
    result.allowFrom = groupConfig.allowFrom;
  }

  const teamOverrides = config.teamOverrides || {};
  const teamConfig = teamOverrides[teamId];

  if (!teamConfig) return result;

  // Apply team-level overrides
  if (teamConfig.requireMention !== undefined) result.requireMention = teamConfig.requireMention;
  if (teamConfig.replyStyle !== undefined) result.replyStyle = teamConfig.replyStyle;
  if (Array.isArray(teamConfig.allowFrom)) result.allowFrom = teamConfig.allowFrom;

  // Apply channel-level overrides
  const channels = teamConfig.channels || {};
  const channelConfig = channels[conversationId];

  if (!channelConfig) return result;

  if (channelConfig.requireMention !== undefined) result.requireMention = channelConfig.requireMention;
  if (channelConfig.replyStyle !== undefined) result.replyStyle = channelConfig.replyStyle;
  if (Array.isArray(channelConfig.allowFrom)) result.allowFrom = channelConfig.allowFrom;

  return result;
}

export function isSmartGroup(config, conversationId) {
  const groups = config.groups || {};
  const group = groups[conversationId];
  return group?.mode === 'smart';
}

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(content);
      config = mergeConfigWithDefaults(parsed);
    } else {
      console.warn(`[teams] Config file not found: ${CONFIG_PATH}`);
      config = mergeConfigWithDefaults();
    }
  } catch (err) {
    console.error(`[teams] Failed to load config: ${err.message}`);
    config = mergeConfigWithDefaults();
  }
  return config;
}

export function getConfig() {
  if (!config) {
    loadConfig();
  }
  return config;
}

export function saveConfig(newConfig) {
  const tmpPath = CONFIG_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(newConfig, null, 2));
    fs.renameSync(tmpPath, CONFIG_PATH);
    config = newConfig;
    return true;
  } catch (err) {
    console.error(`[teams] Failed to save config: ${err.message}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return false;
  }
}

export function watchConfig(onChange) {
  if (configWatcher) {
    configWatcher.close();
  }
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = null;
  }

  const configDir = path.dirname(CONFIG_PATH);
  const configBase = path.basename(CONFIG_PATH);

  const scheduleReload = () => {
    if (configReloadTimer) clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(() => {
      configReloadTimer = null;
      if (!fs.existsSync(CONFIG_PATH)) {
        return;
      }
      console.log('[teams] Config file changed, reloading...');
      loadConfig();
      if (onChange) {
        onChange(config);
      }
    }, 100);
  };

  if (fs.existsSync(configDir)) {
    configWatcher = fs.watch(configDir, (eventType, filename) => {
      if (filename && String(filename) === configBase) {
        scheduleReload();
      }
    });
    configWatcher.on('error', (err) => {
      console.warn(`[teams] Config watcher error: ${err.message}`);
      if (configReloadTimer) {
        clearTimeout(configReloadTimer);
        configReloadTimer = null;
      }
      try {
        configWatcher.close();
      } catch {}
      configWatcher = null;
    });
  }
}

export function stopWatching() {
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = null;
  }
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
}

export function getCredentials() {
  return {
    appId: process.env.MSTEAMS_APP_ID || '',
    appPassword: process.env.MSTEAMS_APP_PASSWORD || '',
    tenantId: process.env.MSTEAMS_TENANT_ID || ''
  };
}
