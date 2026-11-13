import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('scripts/send.js', () => {
  let tmpDir;
  let server;
  let port;
  let tokenPath;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-teams-send-'));
    const dataDir = path.join(tmpDir, 'zylos/components/ms-teams');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'zylos'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'zylos/.env'), '');
    tokenPath = path.join(dataDir, '.internal-token');
    fs.writeFileSync(tokenPath, 'token-old');

    server = http.createServer((req, res) => {
      if (req.url === '/internal/react') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.url !== '/internal/send') {
        res.writeHead(404);
        res.end();
        return;
      }

      const token = req.headers['x-internal-token'];
      if (token === 'token-old') {
        fs.writeFileSync(tokenPath, 'token-new');
        res.writeHead(429, { 'retry-after': '0' });
        res.end(JSON.stringify({ error: 'rate limited' }));
        return;
      }

      if (token === 'token-new') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      enabled: true,
      port,
      owner: { bound: true, aadObjectId: 'aad-owner', name: 'Owner' },
      groups: {},
      channels: {},
    }));
    // The outbound DM check reads the recipient from the stored conversation.
    fs.writeFileSync(path.join(dataDir, 'conversations.json'), JSON.stringify({
      'conv-1': { conversation: { id: 'conv-1', conversationType: 'personal' }, user: { aadObjectId: 'aad-owner', name: 'Owner' }, savedAt: Date.now(), lastAccessed: Date.now() },
    }));
  });

  afterEach(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
      server = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('re-reads the internal token on retry after rate limiting', async () => {
    const scriptPath = path.resolve('scripts/send.js');

    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      'conv-1|type:dm',
      'hello',
    ], {
      env: { ...process.env, HOME: tmpDir },
      timeout: 10000,
    });

    expect(stdout).toContain('Message sent successfully');
  });
});

describe('scripts/send.js owner-reply exception (review item 5)', () => {
  let home;
  let server;
  let payloads;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-teams-reply-'));
    const dataDir = path.join(home, 'zylos/components/ms-teams');
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'zylos/.env'), '');
    fs.writeFileSync(path.join(dataDir, '.internal-token'), 't');
    payloads = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (req.url === '/internal/send') payloads.push(JSON.parse(body));
        if (req.url === '/internal/send-media') payloads.push({ media: true });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, activityId: 'a1' }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      enabled: true,
      port: server.address().port,
      owner: { bound: true, aadObjectId: 'aad-owner', name: 'Owner' },
      groupPolicy: 'allowlist',
      replyStyle: 'new',
      groups: {},
      channels: {},
    }));
    fs.writeFileSync(path.join(dataDir, 'conversations.json'), JSON.stringify({
      '19:c@thread.tacv2': { conversation: { id: '19:c@thread.tacv2', conversationType: 'channel' }, serviceUrl: 'https://s', savedAt: Date.now() },
    }));
    fs.writeFileSync(path.join(dataDir, 'logs', '19_c_thread.tacv2_messageid_1.jsonl'),
      JSON.stringify({ message_id: 'm1', user_id: 'aad-owner', accepted: true }) + '\n');
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = (text) => execFileAsync(process.execPath, [
    path.resolve('scripts/send.js'), '19:c@thread.tacv2;messageid=1|type:channel|msg:m1', text,
  ], { env: { ...process.env, HOME: home }, timeout: 15000 }).then(() => null, (e) => e);

  it('every chunk is sent as a required reply, even with replyStyle=new', async () => {
    const err = await run('x'.repeat(9000));
    expect(err).toBeNull();
    expect(payloads.length).toBeGreaterThan(1);
    for (const p of payloads) {
      expect(p.replyToId).toBe('m1');
      expect(p.requireReply).toBe(true);
    }
  });

  it('media is refused under the exception', async () => {
    const err = await run('[MEDIA:image]/tmp/x.png');
    expect(err?.code).toBe(1);
    expect(err.stderr).toContain('outbound blocked: media');
    expect(payloads).toEqual([]);
  });
});
