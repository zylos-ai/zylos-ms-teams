const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export function timedFetch(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

export async function safeFetch(url, options = {}, { allowHosts = [], timeoutMs = DEFAULT_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(current, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    const status = res.status;
    if (status < 300 || status >= 400) return res;

    const location = res.headers.get('location');
    if (!location) return res;

    const resolved = new URL(location, current).href;
    if (!isHostAllowed(resolved, allowHosts)) {
      throw new Error(`Redirect to disallowed host: ${resolved}`);
    }
    current = resolved;
  }
  throw new Error(`Too many redirects (max ${maxRedirects})`);
}

function isHostAllowed(url, allowHosts) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { return false; }
  if (!host) return false;
  return allowHosts.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}
