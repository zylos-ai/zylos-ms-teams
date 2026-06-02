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

export function expectedCloudHosts(rawCloud = 'public') {
  const cloud = getCloudConfig(rawCloud);
  return [...new Set([
    cloud.loginHost,
    new URL(cloud.graphBase).host,
    new URL(cloud.graphScope).host,
    new URL(cloud.botFrameworkScope).host,
  ])];
}

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

export function buildOpenIdConfigUrl(tenantId, rawCloud = 'public') {
  const cloud = getCloudConfig(rawCloud);
  return `https://${cloud.loginHost}/${tenantId}/v2.0/.well-known/openid-configuration`;
}

export function buildGraphUrl(path, rawCloud = 'public') {
  const cloud = getCloudConfig(rawCloud);
  if (String(path || '').startsWith('http')) return path;
  return `${cloud.graphBase}${String(path || '').startsWith('/') ? '' : '/'}${path || ''}`;
}

function hostFromUrl(value = '') {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

export async function probeCloudEndpoint({
  tenantId,
  cloud: rawCloud = 'public',
  fetchImpl = fetch,
} = {}) {
  if (!tenantId) {
    return { ok: false, detail: 'tenant id missing' };
  }

  const cloud = getCloudConfig(rawCloud);
  const url = buildOpenIdConfigUrl(tenantId, cloud.name);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  const responseHost = hostFromUrl(res.url || url);

  if (!res.ok) {
    return { ok: false, detail: `metadata probe failed: HTTP ${res.status}` };
  }

  const metadata = await res.json();
  const issuer = metadata.issuer || '';
  const issuerHost = hostFromUrl(issuer);
  const expectedHosts = expectedCloudHosts(cloud.name);
  const actualHosts = [responseHost, issuerHost].filter(Boolean);
  const mismatched = actualHosts.filter(host => !expectedHosts.includes(host));

  if (mismatched.length > 0) {
    return {
      ok: false,
      detail: `configured ${cloud.name} expects ${cloud.loginHost}; got ${[...new Set(mismatched)].join(', ')}`,
    };
  }

  return {
    ok: true,
    detail: `${cloud.name} login metadata matches ${cloud.loginHost}`,
  };
}
