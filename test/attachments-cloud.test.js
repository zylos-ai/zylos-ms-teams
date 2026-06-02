import { describe, expect, it } from 'vitest';
import { isAuthAllowed, isUrlAllowed, scopeCandidatesForUrl, tryBuildGraphSharesUrl } from '../src/lib/attachments.js';

describe('attachment cloud URL handling', () => {
  it('allows national cloud Graph media hosts', () => {
    const hosts = [
      'https://graph.microsoft.us/v1.0/me',
      'https://dod-graph.microsoft.us/v1.0/me',
      'https://microsoftgraph.chinacloudapi.cn/v1.0/me',
    ];

    for (const url of hosts) {
      expect(isUrlAllowed(url, [
        'graph.microsoft.us',
        'dod-graph.microsoft.us',
        'microsoftgraph.chinacloudapi.cn',
      ])).toBe(true);
      expect(isAuthAllowed(url)).toBe(true);
    }
  });

  it('builds a configured-cloud Graph shares URL', () => {
    const url = tryBuildGraphSharesUrl('https://contoso.sharepoint.com/:w:/r/file.docx');
    expect(url).toBe('https://graph.microsoft.com/v1.0/shares/u!aHR0cHM6Ly9jb250b3NvLnNoYXJlcG9pbnQuY29tLzp3Oi9yL2ZpbGUuZG9jeA/driveItem/content');
  });

  it('uses shorthand token scopes without duplicate full-resource retries', () => {
    expect(scopeCandidatesForUrl('https://graph.microsoft.us/v1.0/me')).toEqual(['graph', 'botframework']);
    expect(scopeCandidatesForUrl('https://smba.trafficmanager.net/v3/attachments/1')).toEqual(['botframework', 'graph']);
  });
});
