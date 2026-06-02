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
      groups: {},
      channels: {},
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
