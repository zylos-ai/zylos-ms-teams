import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/ms-teams');
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
  channels: {},
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
    channels: parsed.channels || {},
    message: {
      ...DEFAULT_CONFIG.message,
      ...(parsed.message || {})
    }
  };
}

/**
 * Resolve route-level configuration for a conversation.
 *
 * For channels: config.channels[channelId] → posts[postId] (future)
 * For groups:   config.groups[conversationId]
 *
 * @param {string} convType - 'channel' | 'group'
 * @param {string} conversationId - Full conversation ID (may include ;messageid=)
 * @param {object} config - The loaded config
 * @returns {{ requireMention: boolean, replyStyle: string, allowFrom: string[] }}
 */
export function resolveRouteConfig(convType, conversationId, config) {
  const result = {
    requireMention: true,
    replyStyle: 'top-level',
    allowFrom: [],
  };

  const baseConvId = conversationId.split(';')[0];

  if (convType === 'channel') {
    const channels = config.channels || {};
    const chCfg = channels[conversationId] || channels[baseConvId];
    if (!chCfg) return result;

    if (chCfg.mode === 'smart') result.requireMention = false;
    if (chCfg.replyStyle) result.replyStyle = chCfg.replyStyle;
    if (Array.isArray(chCfg.allowFrom) && chCfg.allowFrom.length > 0) {
      result.allowFrom = chCfg.allowFrom;
    }

    // Post-level overrides (future)
    const threadMatch = conversationId.match(/;messageid=(\d+)/);
    if (threadMatch) {
      const postCfg = (chCfg.posts || {})[threadMatch[1]];
      if (postCfg) {
        if (postCfg.mode === 'smart') result.requireMention = false;
        else if (postCfg.mode === 'mention') result.requireMention = true;
        if (Array.isArray(postCfg.allowFrom) && postCfg.allowFrom.length > 0) {
          result.allowFrom = postCfg.allowFrom;
        }
      }
    }
  } else {
    const groups = config.groups || {};
    const grpCfg = groups[conversationId] || groups[baseConvId];
    if (grpCfg && Array.isArray(grpCfg.allowFrom) && grpCfg.allowFrom.length > 0) {
      result.allowFrom = grpCfg.allowFrom;
    }
  }

  return result;
}

export function isSmartConversation(config, convType, conversationId) {
  const baseId = conversationId.split(';')[0];
  if (convType === 'channel') {
    const channels = config.channels || {};
    const ch = channels[conversationId] || channels[baseId];
    if (!ch) return false;
    // Check post-level override first
    const threadMatch = conversationId.match(/;messageid=(\d+)/);
    if (threadMatch) {
      const postCfg = (ch.posts || {})[threadMatch[1]];
      if (postCfg?.mode) return postCfg.mode === 'smart';
    }
    return ch.mode === 'smart';
  }
  const groups = config.groups || {};
  const group = groups[conversationId] || groups[baseId];
  return group?.mode === 'smart';
}

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(content);
      config = mergeConfigWithDefaults(parsed);
    } else {
      console.warn(`[ms-teams] Config file not found: ${CONFIG_PATH}`);
      config = mergeConfigWithDefaults();
    }
  } catch (err) {
    console.error(`[ms-teams] Failed to load config: ${err.message}`);
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
    console.error(`[ms-teams] Failed to save config: ${err.message}`);
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
      console.log('[ms-teams] Config file changed, reloading...');
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
      console.warn(`[ms-teams] Config watcher error: ${err.message}`);
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
