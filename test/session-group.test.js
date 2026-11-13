import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
  escapeId, unescapeId, isValidSessionGroup, sessionGroupFromEndpoint,
} from '../src/lib/session-group.js';
import { buildC4ReceiveArgs, classifyC4Rejection } from '../src/lib/c4.js';

const tmpStore = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'teams-sg-')), 'session-groups.json');

const DM_ID = 'a:1Xq9ZtLm3p-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const GROUP_ID = '19:3b1c0d2e4f5a6b7c8d9e0f1a2b3c4d5e@thread.v2';
const CHANNEL_POST = '19:9f8e7d6c5b4a39281706f5e4d3c2b1a0@thread.tacv2;messageid=1731234567890';

describe('sessionGroupFromEndpoint', () => {
  it.each([
    [`${GROUP_ID}|type:group|user:u1|msg:m1`, 'group-19:3b1c0d2e4f5a6b7c8d9e0f1a2b3c4d5e_athread.v2'],
    [`${CHANNEL_POST}|type:channel|user:u1|msg:1731234567890`, 'channel-19:9f8e7d6c5b4a39281706f5e4d3c2b1a0_athread.tacv2_smessageid_e1731234567890'],
    ['admin|type:dm-pairing', 'admin'],
    ['a:short|type:dm', 'dm-a:short'],
  ])('maps %s', (ep, name) => {
    expect(sessionGroupFromEndpoint(ep, { storePath: tmpStore() })).toBe(name);
    expect(isValidSessionGroup(name)).toBe(true);
  });

  it('per-message parts never change the group', () => {
    const store = tmpStore();
    expect(sessionGroupFromEndpoint(`${GROUP_ID}|type:group|user:a|msg:1`, { storePath: store }))
      .toBe(sessionGroupFromEndpoint(`${GROUP_ID}|type:group|user:b|msg:2`, { storePath: store }));
  });

  it('each channel post is its own group', () => {
    const a = sessionGroupFromEndpoint('19:c@thread.tacv2;messageid=1|type:channel');
    const b = sessionGroupFromEndpoint('19:c@thread.tacv2;messageid=2|type:channel');
    expect(a).not.toBe(b);
  });

  it('long ids get a stored short id; lookups reuse it and never create', () => {
    const store = tmpStore();
    const ep = `${DM_ID}|type:dm|user:u|msg:m`;
    const now = () => 1000;
    const random = () => 0.5;
    expect(() => sessionGroupFromEndpoint(ep, { storePath: store })).toThrow(/no session group stored/);
    // No store and no backup: time base is ms*1000 + random.
    const name = sessionGroupFromEndpoint(ep, { create: true, storePath: store, now, random });
    expect(name).toBe('dm-_1000500');
    expect(sessionGroupFromEndpoint(ep, { storePath: store })).toBe('dm-_1000500');
    expect(sessionGroupFromEndpoint(`${DM_ID}x|type:dm`, { create: true, storePath: store, now })).toBe('dm-_1000501');
  });

  it('existing stored ids stay; numbering never goes below stored next or max id', () => {
    const store = tmpStore();
    fs.writeFileSync(store, JSON.stringify({ ids: { 'dm|old': 'dm-_7' }, next: 3 }));
    expect(sessionGroupFromEndpoint('old|type:dm', { storePath: store })).toBe('dm-old');
    expect(sessionGroupFromEndpoint(`${DM_ID}|type:dm`, { create: true, storePath: store, now: () => 1 })).toBe('dm-_8');
  });

  it.each([
    ['truncated JSON', '{"ids": {"dm|a": "dm-_1"'],
    ['empty file (rename without fsync)', ''],
    ['ids: null', '{"ids": null, "next": 2}'],
    ['ids array', '{"ids": [], "next": 2}'],
    ['bad next', '{"ids": {}, "next": "2"}'],
    ['bad value', '{"ids": {"dm|a": "evil"}, "next": 2}'],
    ['duplicate ids', '{"ids": {"dm|a": "dm-_1", "dm|b": "dm-_1"}, "next": 2}'],
  ])('corrupt store (%s): create throws and the file is not rewritten', (_n, content) => {
    const store = tmpStore();
    fs.writeFileSync(store, content);
    expect(() => sessionGroupFromEndpoint(`${DM_ID}|type:dm`, { create: true, storePath: store })).toThrow(/session group store/);
    expect(() => sessionGroupFromEndpoint(`${DM_ID}|type:dm`, { storePath: store })).toThrow(/session group store/);
    expect(fs.readFileSync(store, 'utf8')).toBe(content);
  });

  it('lost store never reuses an id (A -> dm-_1 earlier, B after loss gets a new id)', () => {
    const store = tmpStore();
    const a = sessionGroupFromEndpoint(`${DM_ID}A|type:dm`, { create: true, storePath: store, now: () => 5000 });
    fs.rmSync(store);
    fs.rmSync(`${store}.bak`, { force: true });
    const b = sessionGroupFromEndpoint(`${DM_ID}B|type:dm`, { create: true, storePath: store, now: () => 5001 });
    expect(b).not.toBe(a);
  });

  it('both files lost with a fixed clock: new id never equals an earlier one', () => {
    const store = tmpStore();
    let t = 7000;
    const now = () => t;
    const earlier = [];
    fs.writeFileSync(store, JSON.stringify({ ids: {}, next: 1 }));
    for (let i = 0; i < 5; i++) earlier.push(sessionGroupFromEndpoint(`${DM_ID}${i}|type:dm`, { create: true, storePath: store, now }));
    expect(earlier[2]).toBe('dm-_7002');
    fs.rmSync(store);
    fs.rmSync(`${store}.bak`);
    t += 2;
    const fresh = sessionGroupFromEndpoint(`${DM_ID}new|type:dm`, { create: true, storePath: store, now, random: () => 0 });
    expect(fresh).toBe('dm-_7002000');
    expect(earlier).not.toContain(fresh);
  });

  it.each([
    ['empty file', ''],
    ['truncated JSON', '{"ids": {'],
    ['ids: null', '{"ids": null, "next": 2}'],
  ])('corrupt store (%s) with valid .bak: uses .bak, moves bad file aside, rewrites main on create', (_n, content) => {
    const store = tmpStore();
    const now = () => 10;
    const a = sessionGroupFromEndpoint(`${DM_ID}A|type:dm`, { create: true, storePath: store, now });
    fs.writeFileSync(store, content);
    expect(sessionGroupFromEndpoint(`${DM_ID}A|type:dm`, { storePath: store })).toBe(a);
    const aside = fs.readdirSync(path.dirname(store)).filter(f => f.startsWith(`${path.basename(store)}.corrupt-`));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(store), aside[0]), 'utf8')).toBe(content);
    expect(fs.existsSync(store)).toBe(false);
    const b = sessionGroupFromEndpoint(`${DM_ID}B|type:dm`, { create: true, storePath: store, now });
    expect(b).not.toBe(a);
    const main = JSON.parse(fs.readFileSync(store, 'utf8'));
    expect(Object.values(main.ids)).toEqual(expect.arrayContaining([a, b]));
  });

  it('corrupt store and corrupt .bak: still refuses and rewrites nothing', () => {
    const store = tmpStore();
    fs.writeFileSync(store, '');
    fs.writeFileSync(`${store}.bak`, '{"ids": null, "next": 2}');
    expect(() => sessionGroupFromEndpoint(`${DM_ID}|type:dm`, { create: true, storePath: store })).toThrow(/session group store/);
    expect(fs.readFileSync(store, 'utf8')).toBe('');
    expect(fs.readFileSync(`${store}.bak`, 'utf8')).toBe('{"ids": null, "next": 2}');
  });

  it('missing store is restored from .bak, keeping earlier ids', () => {
    const store = tmpStore();
    const now = () => 10;
    const a = sessionGroupFromEndpoint(`${DM_ID}A|type:dm`, { create: true, storePath: store, now });
    const b = sessionGroupFromEndpoint(`${DM_ID}B|type:dm`, { create: true, storePath: store, now });
    fs.rmSync(store);
    expect(sessionGroupFromEndpoint(`${DM_ID}A|type:dm`, { storePath: store })).toBe(a);
    const c = sessionGroupFromEndpoint(`${DM_ID}C|type:dm`, { create: true, storePath: store, now });
    expect([a, b]).not.toContain(c);
  });

  it('unescapeId rejects malformed _x escapes', () => {
    expect(() => unescapeId('a_xZZ')).toThrow(/invalid escape/);
    expect(() => unescapeId('a_x4')).toThrow(/invalid escape/);
    expect(unescapeId('a_x20b')).toBe('a b');
  });

  it('escaping is reversible and one-to-one', () => {
    const ids = ['a_b', 'a@b', 'a;b', 'a=b', 'a/b', 'a+b', 'a,b', 'a b', 'a__b', 'é', 'a_ab'];
    const escaped = ids.map(escapeId);
    expect(new Set(escaped).size).toBe(ids.length);
    for (const id of ids) expect(unescapeId(escapeId(id))).toBe(id);
  });

  it('rejects invalid endpoints instead of returning the overall group', () => {
    expect(() => sessionGroupFromEndpoint('conv')).toThrow();
    expect(() => sessionGroupFromEndpoint('|type:dm')).toThrow();
    expect(() => sessionGroupFromEndpoint('conv|type:weird')).toThrow();
  });

  it('CLI prints the group, and fails with exit 1 and empty stdout', () => {
    const ok = spawnSync(process.execPath, ['scripts/session-group.js', `${GROUP_ID}|type:group`], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('group-19:3b1c0d2e4f5a6b7c8d9e0f1a2b3c4d5e_athread.v2\n');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-sg-home-'));
    const bad = spawnSync(process.execPath, ['scripts/session-group.js', `${DM_ID}|type:dm`], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
  });
});

describe('buildC4ReceiveArgs', () => {
  const setup = (options) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-c4-'));
    if (options) fs.writeFileSync(path.join(dir, 'c4-receive-options.json'), JSON.stringify({ options }));
    return path.join(dir, 'c4-receive.js');
  };
  const base = ['--channel', 'ms-teams', '--endpoint', 'e', '--json', '--content', 'c'];

  it('old Core without manifest: args unchanged', () => {
    expect(buildC4ReceiveArgs({ source: 'ms-teams', endpoint: 'e', content: 'c', sessionGroup: 'dm-x', c4Receive: setup() })).toEqual(base);
  });
  it('manifest without --session-group: args unchanged', () => {
    expect(buildC4ReceiveArgs({ source: 'ms-teams', endpoint: 'e', content: 'c', sessionGroup: 'dm-x', c4Receive: setup({ '--channel': {} }) })).toEqual(base);
  });
  it('manifest with --session-group: group passed', () => {
    expect(buildC4ReceiveArgs({ source: 'ms-teams', endpoint: 'e', content: 'c', sessionGroup: 'dm-x', c4Receive: setup({ '--session-group': { takesValue: true } }) }))
      .toEqual([...base, '--session-group', 'dm-x']);
  });
  it('classifies rejections by persisted', () => {
    expect(classifyC4Rejection({ error: { persisted: ['r'] } })).toBe('committed');
    expect(classifyC4Rejection({ error: { persisted: [] } })).toBe('not_stored');
    expect(classifyC4Rejection({ error: {} })).toBe('uncertain');
  });
});
