export const CLOUDS = {
  public: {
    name: 'public',
    loginHost: 'login.microsoftonline.com',
    graphBase: 'https://graph.microsoft.com/v1.0',
    graphScope: 'https://graph.microsoft.com/.default',
    botFrameworkScope: 'https://api.botframework.com/.default',
    botFrameworkIssuer: 'https://api.botframework.com',
    botFrameworkJwksUri: 'https://login.botframework.com/v1/.well-known/keys',
    legacyStsIssuer: 'https://sts.windows.net/',
  },
  gccHigh: {
    name: 'gccHigh',
    loginHost: 'login.microsoftonline.us',
    graphBase: 'https://graph.microsoft.us/v1.0',
    graphScope: 'https://graph.microsoft.us/.default',
    botFrameworkScope: 'https://api.botframework.us/.default',
    botFrameworkIssuer: 'https://api.botframework.us',
    botFrameworkJwksUri: 'https://login.botframework.us/v1/.well-known/keys',
    legacyStsIssuer: 'https://sts.windows.net/',
  },
  dod: {
    name: 'dod',
    loginHost: 'login.microsoftonline.us',
    graphBase: 'https://dod-graph.microsoft.us/v1.0',
    graphScope: 'https://dod-graph.microsoft.us/.default',
    botFrameworkScope: 'https://api.botframework.us/.default',
    botFrameworkIssuer: 'https://api.botframework.us',
    botFrameworkJwksUri: 'https://login.botframework.us/v1/.well-known/keys',
    legacyStsIssuer: 'https://sts.windows.net/',
  },
  china: {
    name: 'china',
    loginHost: 'login.chinacloudapi.cn',
    graphBase: 'https://microsoftgraph.chinacloudapi.cn/v1.0',
    graphScope: 'https://microsoftgraph.chinacloudapi.cn/.default',
    botFrameworkScope: 'https://api.botframework.azure.cn/.default',
    botFrameworkIssuer: 'https://api.botframework.azure.cn',
    botFrameworkJwksUri: 'https://login.botframework.azure.cn/v1/.well-known/keys',
    legacyStsIssuer: 'https://sts.chinacloudapi.cn/',
  },
};

const ALIASES = {
  global: 'public',
  commercial: 'public',
  public: 'public',
  gcc: 'public',
  'gcc-high': 'gccHigh',
  gcchigh: 'gccHigh',
  gcc_high: 'gccHigh',
  usgov: 'gccHigh',
  dod: 'dod',
  dodb: 'dod',
  china: 'china',
  '21vianet': 'china',
};

export function normalizeCloudName(raw = 'public') {
  const key = String(raw || 'public').trim();
  if (!key) return 'public';
  return ALIASES[key.toLowerCase()] || key;
}

export function getCloudConfig(raw = 'public') {
  const name = normalizeCloudName(raw);
  return CLOUDS[name] || CLOUDS.public;
}

export function buildLoginUrl(tenantId, rawCloud = 'public', path = 'oauth2/v2.0/token') {
  const cloud = getCloudConfig(rawCloud);
  return `https://${cloud.loginHost}/${tenantId}/${path.replace(/^\/+/, '')}`;
}

export function buildGraphUrl(path, rawCloud = 'public') {
  const cloud = getCloudConfig(rawCloud);
  if (String(path || '').startsWith('http')) return path;
  return `${cloud.graphBase}${String(path || '').startsWith('/') ? '' : '/'}${path || ''}`;
}
