const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export function timedFetch(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

export async function safeFetch(url, options = {}, { allowHosts = [], timeoutMs = DEFAULT_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS } = {}) {
  let current = url;
  const requestOrigin = new URL(url).origin;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timeoutController.abort(new Error(`Fetch timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timeout.unref?.();

  try {
    for (let i = 0; i <= maxRedirects; i++) {
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutController.signal])
        : timeoutController.signal;
      const res = await fetch(current, {
        ...options,
        redirect: 'manual',
        signal,
      });

      const status = res.status;
      if (status < 300 || status >= 400) return res;

      const location = res.headers.get('location');
      if (!location) return res;

      const resolved = new URL(location, current);
      if (resolved.protocol !== 'https:') {
        throw new Error(`Redirect to non-HTTPS URL: ${resolved.href}`);
      }
      if (!isHostAllowed(resolved.href, allowHosts)) {
        throw new Error(`Redirect to disallowed host: ${resolved.href}`);
      }

      current = resolved.href;

      if (resolved.origin !== requestOrigin) {
        const { Authorization, authorization, ...safeHeaders } = options.headers || {};
        options = { ...options, headers: safeHeaders };
      }
    }
    throw new Error(`Too many redirects (max ${maxRedirects})`);
  } finally {
    clearTimeout(timeout);
  }
}

function isHostAllowed(url, allowHosts) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { return false; }
  if (!host) return false;
  return allowHosts.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}
