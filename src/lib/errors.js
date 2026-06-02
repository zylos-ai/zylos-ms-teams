export function classifyApiError({ status, message = '', headers, error } = {}) {
  const rawStatus = Number(status || error?.status || error?.statusCode || 0);
  const rawMessage = String(message || error?.message || '').trim();
  const retryAfter = headers?.get?.('retry-after') || headers?.['retry-after'] || '';

  if (rawStatus === 401 || rawStatus === 403) {
    return {
      class: 'auth',
      status: rawStatus,
      hint: rawStatus === 403
        ? 'check app permissions and admin consent in Azure Portal'
        : 'check credentials, token audience, and tenant/cloud configuration',
    };
  }

  if (rawStatus === 429) {
    return {
      class: 'throttle',
      status: rawStatus,
      retryAfter,
      hint: `throttled${retryAfter ? `, retry-after: ${retryAfter}s` : '; retry later'}`,
    };
  }

  if (rawStatus === 404) {
    return {
      class: 'not-found',
      status: rawStatus,
      hint: 'verify the conversation, team, channel, or message ID still exists',
    };
  }

  if (rawStatus >= 500) {
    return {
      class: 'server',
      status: rawStatus,
      hint: 'Microsoft service error; retry and check service health if it persists',
    };
  }

  if (error?.name === 'AbortError' || /\b(timeout|network|fetch|ECONN|ENOTFOUND|EAI_AGAIN)\b/i.test(rawMessage)) {
    return {
      class: 'network',
      status: rawStatus || null,
      hint: 'check network connectivity, proxy settings, and endpoint reachability',
    };
  }

  return {
    class: 'unknown',
    status: rawStatus || null,
    hint: 'inspect the raw error and request context',
  };
}

export function appendErrorHint(message, details = {}) {
  const classified = classifyApiError({ ...details, message });
  const prefix = classified.status
    ? `${classified.class}, HTTP ${classified.status}`
    : classified.class;
  return `${message} [${prefix}; hint: ${classified.hint}]`;
}
