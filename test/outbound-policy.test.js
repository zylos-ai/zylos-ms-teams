import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import { outboundDenialReason, outboundDecision, findLoggedMessage, realConversationType } from '../src/lib/outbound-policy.js';

const owner = { bound: true, aadObjectId: 'aad-owner', name: 'Owner' };
const ref = (conversationType, user = { aadObjectId: 'aad-owner', name: 'Owner' }) => ({ conversation: { conversationType }, user });
const deps = (r = null, logged = {}) => ({
  ref: r,
  findMessage: (_c, id) => logged[id] || null,
});

describe('realConversationType', () => {
  it.each([
    ['personal', 'dm'], ['groupChat', 'group'], ['channel', 'channel'], [undefined, null], ['other', null], ['toString', null],
  ])('%s -> %s', (t, real) => expect(realConversationType({ conversation: { conversationType: t } })).toBe(real));
});

describe('outbound DM policy', () => {
  it.each([
    ['owner', { owner, dmPolicy: 'owner' }, { aadObjectId: 'aad-owner' }, true],
    ['stranger under owner policy', { owner, dmPolicy: 'owner' }, { aadObjectId: 'x' }, false],
    ['allowlisted user', { owner, dmPolicy: 'allowlist', dmAllowFrom: ['aad-a'] }, { aadObjectId: 'aad-a' }, true],
    ['unlisted user under allowlist', { owner, dmPolicy: 'allowlist', dmAllowFrom: ['aad-a'] }, { aadObjectId: 'x' }, false],
    ['anyone under open', { owner, dmPolicy: 'open' }, { aadObjectId: 'x' }, true],
    ['owner under disabled (matches inbound)', { owner, dmPolicy: 'disabled' }, { aadObjectId: 'aad-owner' }, false],
  ])('%s', (_n, config, user, allowed) => {
    expect(outboundDenialReason(config, { conversationId: 'a:1', type: 'dm' }, deps(ref('personal', user))) === null).toBe(allowed);
  });

  it('unknown DM conversation is denied (endpoint user: part is ignored)', () => {
    expect(outboundDenialReason({ owner }, { conversationId: 'a:1', type: 'dm', user: 'aad-owner' }, deps(null)))
      .toMatch(/no stored conversation/);
  });

  it('missing type is checked as a DM', () => {
    expect(outboundDenialReason({ owner }, { conversationId: 'a:1' }, deps(ref('personal', { aadObjectId: 'x' })))).toMatch(/DM recipient x/);
  });

  it('admin pairing endpoint is denied', () => {
    expect(outboundDenialReason({ owner }, { conversationId: 'admin', type: 'dm-pairing' }, deps())).toMatch(/unsupported/);
  });
});

describe('forged endpoint type (review item 1)', () => {
  const cfg = { owner, dmPolicy: 'open', groupPolicy: 'open', groups: {}, channels: {} };

  it('a) group chat id with type:dm is denied even when the last speaker is the owner', () => {
    const r = outboundDenialReason({ ...cfg, groupPolicy: 'disabled' }, { conversationId: '19:g@thread.v2', type: 'dm' }, deps(ref('groupChat')));
    expect(r).toMatch(/does not match conversation type group/);
  });

  it('b) another user\'s DM id with type:group is denied under groupPolicy=open', () => {
    const r = outboundDenialReason({ ...cfg, dmPolicy: 'owner' }, { conversationId: 'a:other', type: 'group' }, deps(ref('personal', { aadObjectId: 'x' })));
    expect(r).toMatch(/does not match conversation type dm/);
  });

  it('DM id with type:channel is denied', () => {
    expect(outboundDenialReason(cfg, { conversationId: 'a:other', type: 'channel' }, deps(ref('personal')))).toMatch(/does not match/);
  });

  it('unknown real type is denied for every declared type', () => {
    for (const type of ['dm', 'group', 'channel']) {
      expect(outboundDenialReason(cfg, { conversationId: 'x', type }, deps({ conversation: {}, user: { aadObjectId: 'aad-owner' } })))
        .toMatch(/conversation type unknown/);
    }
  });

  it('missing reference is denied for group/channel too', () => {
    expect(outboundDenialReason(cfg, { conversationId: '19:x', type: 'group' }, deps(null))).toMatch(/no stored conversation/);
  });
});

describe('outbound group/channel policy', () => {
  const cfg = { owner, groupPolicy: 'allowlist', groups: { '19:g@thread.v2': { name: 'g' } }, channels: { '19:c@thread.tacv2': { name: 'c' } } };
  const G = ref('groupChat');
  const C = ref('channel');

  it('allowlisted group chat', () => {
    expect(outboundDenialReason(cfg, { conversationId: '19:g@thread.v2', type: 'group' }, deps(G))).toBeNull();
  });
  it('post in an allowlisted channel', () => {
    expect(outboundDecision(cfg, { conversationId: '19:c@thread.tacv2;messageid=5', type: 'channel' }, deps(C))).toEqual({ reason: null });
  });
  it('open policy', () => {
    expect(outboundDenialReason({ owner, groupPolicy: 'open' }, { conversationId: '19:x', type: 'group' }, deps(G))).toBeNull();
  });
  it('unlisted: proactive denied', () => {
    expect(outboundDenialReason(cfg, { conversationId: '19:x', type: 'group' }, deps(G))).toMatch(/not allowed/);
  });
  it('unlisted channel: reply to accepted owner message allowed, reply-only', () => {
    expect(outboundDecision(cfg, { conversationId: '19:x;messageid=1', type: 'channel', msg: 'm1' }, deps(C, { m1: { user_id: 'aad-owner' } })))
      .toEqual({ reason: null, replyOnly: true });
  });
  it('unlisted group chat: no owner-reply exception (Teams has no reply threading there)', () => {
    expect(outboundDenialReason(cfg, { conversationId: '19:x', type: 'group', msg: 'm1' }, deps(G, { m1: { user_id: 'aad-owner' } }))).toMatch(/not allowed/);
  });
  it('unlisted: reply to logged non-owner message denied', () => {
    expect(outboundDenialReason(cfg, { conversationId: '19:x', type: 'channel', msg: 'm1' }, deps(C, { m1: { user_id: 'u' } }))).not.toBeNull();
  });
  it('unlisted: reply to unlogged message denied', () => {
    expect(outboundDenialReason(cfg, { conversationId: '19:x', type: 'channel', msg: 'm9' }, deps(C))).not.toBeNull();
  });
  it('disabled denies everything, owner replies included (matches inbound)', () => {
    const d = { ...cfg, groupPolicy: 'disabled' };
    expect(outboundDenialReason(d, { conversationId: '19:g@thread.v2', type: 'group' }, deps(G))).not.toBeNull();
    expect(outboundDenialReason(d, { conversationId: '19:x', type: 'channel', msg: 'm1' }, deps(C, { m1: { user_id: 'aad-owner' } }))).not.toBeNull();
  });
});

describe('findLoggedMessage', () => {
  it('only accepted records count; Graph/unmarked records never shadow or prove', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-logs-'));
    fs.writeFileSync(path.join(dir, '19_x_thread.v2.jsonl'), [
      '{"message_id":"m1","user_id":"aad-owner","accepted":true}',
      'not json',
      '{"message_id":"m1","user_id":"Owner Display Name"}',
      '{"message_id":"m2","user_id":"aad-owner"}',
    ].join('\n') + '\n');
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
    fs.writeFileSync(path.join(dataDir, 'conversations.json'), JSON.stringify({
      '19:x@thread.v2': { conversation: { id: '19:x@thread.v2', conversationType: 'groupChat' }, user: { aadObjectId: 'aad-owner' }, savedAt: Date.now() },
    }));
    const err = await promisify(execFile)(process.execPath, [path.resolve('scripts/send.js'), '19:x@thread.v2|type:group', 'hello'], { env: { ...process.env, HOME: home } })
      .then(() => null, (e) => e);
    expect(err?.code).toBe(1);
    expect(err.stderr).toContain('outbound blocked: group 19:x@thread.v2 is not allowed');
    // Forged type: the same group id declared as a DM (owner was last speaker).
    const forged = await promisify(execFile)(process.execPath, [path.resolve('scripts/send.js'), '19:x@thread.v2|type:dm', 'hello'], { env: { ...process.env, HOME: home } })
      .then(() => null, (e) => e);
    expect(forged?.code).toBe(1);
    expect(forged.stderr).toContain('does not match conversation type group');
  });
});
