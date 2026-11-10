import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import { outboundDenialReason, findLoggedMessage } from '../src/lib/outbound-policy.js';

const owner = { bound: true, aadObjectId: 'aad-owner', name: 'Owner' };
const deps = (recipient = null, logged = {}) => ({
  getRecipient: () => recipient,
  findMessage: (_c, id) => logged[id] || null,
});

describe('outbound DM policy', () => {
  it.each([
    ['owner', { owner, dmPolicy: 'owner' }, { aadObjectId: 'aad-owner' }, true],
    ['stranger under owner policy', { owner, dmPolicy: 'owner' }, { aadObjectId: 'x' }, false],
    ['allowlisted user', { owner, dmPolicy: 'allowlist', dmAllowFrom: ['aad-a'] }, { aadObjectId: 'aad-a' }, true],
    ['unlisted user under allowlist', { owner, dmPolicy: 'allowlist', dmAllowFrom: ['aad-a'] }, { aadObjectId: 'x' }, false],
    ['anyone under open', { owner, dmPolicy: 'open' }, { aadObjectId: 'x' }, true],
    ['owner under disabled (matches inbound)', { owner, dmPolicy: 'disabled' }, { aadObjectId: 'aad-owner' }, false],
  ])('%s', (_n, config, recipient, allowed) => {
    expect(outboundDenialReason(config, { conversationId: 'a:1', type: 'dm' }, deps(recipient)) === null).toBe(allowed);
  });

  it('unknown DM conversation is denied (endpoint user: part is ignored)', () => {
    expect(outboundDenialReason({ owner }, { conversationId: 'a:1', type: 'dm', user: 'aad-owner' }, deps(null)))
      .toMatch(/cannot verify DM recipient/);
  });

  it('missing type is checked as a DM', () => {
    expect(outboundDenialReason({ owner }, { conversationId: 'a:1' }, deps({ aadObjectId: 'x' }))).toMatch(/DM recipient x/);
  });

  it('admin pairing endpoint is denied', () => {
    expect(outboundDenialReason({ owner }, { conversationId: 'admin', type: 'dm-pairing' }, deps())).toMatch(/unsupported/);
  });
});

describe('outbound group/channel policy', () => {
  const cfg = { owner, groupPolicy: 'allowlist', groups: { '19:g@thread.v2': { name: 'g' } }, channels: { '19:c@thread.tacv2': { name: 'c' } } };

  it('allowlisted group chat', () => {
    expect(outboundDenialReason(cfg, { conversationId: '19:g@thread.v2', type: 'group' }, deps())).toBeNull();
  });
  it('post in an allowlisted channel', () => {
    expect(outboundDenialReason(cfg, { conversationId: '19:c@thread.tacv2;messageid=5', type: 'channel' }, deps())).toBeNull();
  });
  it('open policy', () => {
    expect(outboundDenialReason({ owner, groupPolicy: 'open' }, { conversationId: '19:x', type: 'group' }, deps())).toBeNull();
  });
  it('unlisted: proactive denied', () => {
    expect(outboundDenialReason(cfg, { conversationId: '19:x', type: 'group' }, deps())).toMatch(/not allowed/);
  });
  it('unlisted: reply to logged owner message allowed', () => {
    expect(outboundDenialReason(cfg, { conversationId: '19:x', type: 'group', msg: 'm1' }, deps(null, { m1: { user_id: 'aad-owner' } }))).toBeNull();
  });
  it('unlisted: reply to logged non-owner message denied', () => {
    expect(outboundDenialReason(cfg, { conversationId: '19:x', type: 'group', msg: 'm1' }, deps(null, { m1: { user_id: 'u' } }))).not.toBeNull();
  });
  it('unlisted: reply to unlogged message denied', () => {
    expect(outboundDenialReason(cfg, { conversationId: '19:x', type: 'channel', msg: 'm9' }, deps())).not.toBeNull();
  });
  it('disabled denies everything, owner replies included (matches inbound)', () => {
    const d = { ...cfg, groupPolicy: 'disabled' };
    expect(outboundDenialReason(d, { conversationId: '19:g@thread.v2', type: 'group' }, deps())).not.toBeNull();
    expect(outboundDenialReason(d, { conversationId: '19:x', type: 'group', msg: 'm1' }, deps(null, { m1: { user_id: 'aad-owner' } }))).not.toBeNull();
  });
});

describe('findLoggedMessage', () => {
  it('reads the component inbound log for the conversation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-logs-'));
    fs.writeFileSync(path.join(dir, '19_x_thread.v2.jsonl'), '{"message_id":"m1","user_id":"aad-owner"}\nnot json\n');
    expect(findLoggedMessage('19:x@thread.v2', 'm1', dir)?.user_id).toBe('aad-owner');
    expect(findLoggedMessage('19:x@thread.v2', 'm2', dir)).toBeNull();
    expect(findLoggedMessage('19:none', 'm1', dir)).toBeNull();
  });
});

describe('send.js blocks before any network call', () => {
  it('exits 1 with outbound blocked and contacts nothing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-send-'));
    const dataDir = path.join(home, 'zylos/components/ms-teams');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(home, 'zylos/.env'), '');
    // Port 1: any network attempt would fail differently than the policy error.
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ enabled: true, port: 1, owner, groupPolicy: 'allowlist', groups: {}, channels: {} }));
    fs.writeFileSync(path.join(dataDir, '.internal-token'), 't');
    const err = await promisify(execFile)(process.execPath, [path.resolve('scripts/send.js'), '19:x@thread.v2|type:group', 'hello'], { env: { ...process.env, HOME: home } })
      .then(() => null, (e) => e);
    expect(err?.code).toBe(1);
    expect(err.stderr).toContain('outbound blocked: group 19:x@thread.v2 is not allowed');
  });
});
