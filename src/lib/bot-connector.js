function activityIdFromLocation(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return '';
  const last = value.split('/').filter(Boolean).pop() || '';
  return decodeURIComponent(last);
}

export async function readActivityIdFromResponse(response, { log = console.warn } = {}) {
  const contentType = response.headers?.get?.('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      const result = await response.json();
      if (result?.id) return result.id;
    } catch (err) {
      log?.(`[ms-teams] Failed to parse Bot Connector JSON response: ${err.message}`);
    }
  }

  const headerId = activityIdFromLocation(response.headers?.get?.('resource-location'))
    || activityIdFromLocation(response.headers?.get?.('location'));
  if (headerId) return headerId;

  return '';
}
