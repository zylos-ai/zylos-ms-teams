import fs from 'fs';
import path from 'path';

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
    message: {
      ...DEFAULT_CONFIG.message,
      ...(parsed.message || {})
    }
  };
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
