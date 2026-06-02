import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getCredentials, getPublicUrl } from './config.js';
import { isGraphEnabled, acquireTokenForScope, probeGraphToken } from './graph.js';
import { getActiveSubscriptions } from './channel-subscriptions.js';
import { getCloudConfig, probeCloudEndpoint } from './cloud.js';
import { probeDelegatedAuth } from './delegated-auth.js';

function check(name, ok, detail = '') {
  return { name, ok: Boolean(ok), detail };
}

function formatStatus(ok) {
  return ok ? 'ok' : 'warn';
}

export function formatDoctorReport(results) {
  return results
    .map(result => `[${formatStatus(result.ok)}] ${result.name}${result.detail ? ` - ${result.detail}` : ''}`)
    .join('\n');
}

export async function runDoctor(config, {
  fetchImpl = fetch,
  tokenProbe = acquireTokenForScope,
  graphTokenProbe = probeGraphToken,
  delegatedAuthProbe = probeDelegatedAuth,
  cloudProbe = probeCloudEndpoint,
  subscriptionsProvider = getActiveSubscriptions,
} = {}) {
  const credentials = getCredentials();
  const cloud = getCloudConfig(config.cloud || 'public');
  const results = [];

  results.push(check('component enabled', config.enabled !== false, config.enabled === false ? 'config.enabled is false' : 'config.enabled is true'));
  results.push(check('cloud', true, `${cloud.name}: ${cloud.graphBase}`));
  results.push(check('app id', !!credentials.appId, credentials.appId ? 'configured' : 'missing'));
  results.push(check('app password', !!credentials.appPassword, credentials.appPassword ? 'configured' : 'missing'));
  results.push(check('tenant id', !!credentials.tenantId, credentials.tenantId ? 'configured' : 'missing'));
  results.push(check('Graph configuration', isGraphEnabled(), isGraphEnabled() ? 'enabled' : 'requires appId, appPassword, tenantId'));

  try {
    const cloudProbeResult = await cloudProbe({
      tenantId: credentials.tenantId,
      cloud: config.cloud || 'public',
      fetchImpl,
    });
    results.push(check('cloud endpoint probe', cloudProbeResult.ok, cloudProbeResult.detail));
  } catch (err) {
    results.push(check('cloud endpoint probe', false, err.message));
  }

  if (credentials.appId && credentials.appPassword && credentials.tenantId) {
    try {
      const probe = await graphTokenProbe({ tokenProvider: tokenProbe });
      const scopes = probe.scopes || [];
      results.push(check('Graph token probe', true, `token acquired; scopes: ${scopes.length ? scopes.join(', ') : 'none decoded'}`));
      const required = config.graphRequiredScopes || [
        'ChannelMessage.Read.All',
        'Chat.Read.All',
        'Group.Read.All',
        'User.Read.All',
      ];
      const missing = required.filter(scope => !scopes.includes(scope));
      results.push(check('Graph scope audit', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'required scopes present'));
    } catch (err) {
      results.push(check('Graph token probe', false, err.message));
      results.push(check('Graph scope audit', false, 'skipped because Graph token probe failed'));
    }

    try {
      await tokenProbe('botframework');
      results.push(check('Bot Framework token probe', true, 'token acquired'));
    } catch (err) {
      results.push(check('Bot Framework token probe', false, err.message));
    }
  }

  try {
    const delegatedProbe = await delegatedAuthProbe();
    if (!delegatedProbe.configured) {
      results.push(check('Delegated auth probe', true, 'not configured'));
    } else {
      for (const result of delegatedProbe.results) {
        results.push(check(
          `Delegated auth probe: ${result.displayName || result.aadObjectId}`,
          result.ok,
          result.detail
        ));
      }
    }
  } catch (err) {
    results.push(check('Delegated auth probe', false, err.message));
  }

  const publicUrl = getPublicUrl();
  results.push(check('public URL', !publicUrl || publicUrl.startsWith('https://'), publicUrl || 'not configured'));

  const tokenFile = path.join(DATA_DIR, '.internal-token');
  results.push(check('internal token file', fs.existsSync(tokenFile), tokenFile));

  const port = config.port || 3978;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    results.push(check('local service health', res.ok, `HTTP ${res.status}`));
  } catch (err) {
    results.push(check('local service health', false, err.message));
  }

  const channels = config.channels || {};
  const smartChannels = Object.values(channels).filter(channel => channel.mode === 'smart');
  const smartChannelsMissingTeam = smartChannels.filter(channel => !channel.teamId);
  results.push(check('smart channel team IDs', smartChannelsMissingTeam.length === 0, `${smartChannelsMissingTeam.length} missing teamId`));

  const subscriptions = subscriptionsProvider();
  results.push(check('channel subscriptions', smartChannels.length === 0 || Object.keys(subscriptions).length > 0, `${Object.keys(subscriptions).length} active`));

  const groups = config.groups || {};
  const mutableGroupKeys = Object.keys(groups).filter(key => !key.startsWith('19:') && !key.startsWith('a:'));
  results.push(check('group policy shape', mutableGroupKeys.length === 0, mutableGroupKeys.length ? `${mutableGroupKeys.length} non-ID group keys` : 'ok'));

  return results;
}
