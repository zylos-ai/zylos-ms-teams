import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createC4Sender, isSpawnFailure, GENERIC_REJECT_REPLY, UNCERTAIN_REPLY } from '../src/lib/c4.js';

/** A c4-receive path whose Core lists --session-group (multi-session Core). */
function multiSessionC4() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-c4ms-'));
  fs.writeFileSync(path.join(dir, 'c4-receive-options.json'), JSON.stringify({ options: { '--session-group': {} } }));
  return path.join(dir, 'c4-receive.js');
}

function spawnFailure(message = 'spawn node ENOENT') {
  const error = Object.assign(new Error(message), { code: 'ENOENT', syscall: 'spawn node' });
  return { error, stdout: '' };
}

function makeLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeExecFile(results) {
  return vi.fn((cmd, args, options, callback) => {
    const result = results.shift();
    callback(result.error || null, result.stdout || '');
  });
}

function failure(message = 'network down') {
  return { error: new Error(message), stdout: '' };
}

function rejection(message = 'not allowed') {
  return {
    error: new Error('rejected'),
    stdout: JSON.stringify({ ok: false, error: { code: 'ACCESS_DENIED', message } }),
  };
}

describe('sendToC4 onFail handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uncertain failure (c4-receive ran, no structured answer): no retry, onFail once', async () => {
    const execFileImpl = makeExecFile([failure('exit 1 after write'), failure('never used')]);
    const onFail = vi.fn();
    const sendToC4 = createC4Sender({ c4Receive: '/tmp/c4-receive.js', execFileImpl, retryDelayMs: 2000, logger: makeLogger() });
    sendToC4('ms-teams', 'conversation-1|type:dm', 'hello', { onFail });
    await vi.advanceTimersByTimeAsync(5000);
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('maxBuffer overflow is uncertain too: no retry', async () => {
    const err = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    const execFileImpl = makeExecFile([{ error: err, stdout: '' }]);
    const onFail = vi.fn();
    const sendToC4 = createC4Sender({ c4Receive: '/tmp/c4-receive.js', execFileImpl, logger: makeLogger() });
    sendToC4('ms-teams', 'conversation-1|type:dm', 'hello', { onFail });
    await vi.advanceTimersByTimeAsync(5000);
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('isSpawnFailure only matches spawn syscalls', () => {
    expect(isSpawnFailure(spawnFailure().error)).toBe(true);
    expect(isSpawnFailure(new Error('x'))).toBe(false);
    expect(isSpawnFailure(Object.assign(new Error('x'), { syscall: 'read' }))).toBe(false);
  });

  it('fires onFail when both send attempts fail', async () => {
    const execFileImpl = makeExecFile([spawnFailure(), spawnFailure('still down')]);
    const onFail = vi.fn();
    const sendToC4 = createC4Sender({
      c4Receive: '/tmp/c4-receive.js',
      execFileImpl,
      retryDelayMs: 2000,
      logger: makeLogger(),
    });

    sendToC4('ms-teams', 'conversation-1|type:dm', 'hello', { onFail });
    await vi.advanceTimersByTimeAsync(2000);

    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('does not fire onFail when the first attempt succeeds', async () => {
    const execFileImpl = makeExecFile([{ stdout: 'ok' }]);
    const onFail = vi.fn();
    const sendToC4 = createC4Sender({
      c4Receive: '/tmp/c4-receive.js',
      execFileImpl,
      retryDelayMs: 2000,
      logger: makeLogger(),
    });

    sendToC4('ms-teams', 'conversation-1|type:dm', 'hello', { onFail });
    await vi.runOnlyPendingTimersAsync();

    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('does not fire onFail when the retry succeeds', async () => {
    const execFileImpl = makeExecFile([spawnFailure(), { stdout: 'ok' }]);
    const onFail = vi.fn();
    const sendToC4 = createC4Sender({
      c4Receive: '/tmp/c4-receive.js',
      execFileImpl,
      retryDelayMs: 2000,
      logger: makeLogger(),
    });

    sendToC4('ms-teams', 'conversation-1|type:dm', 'hello', { onFail });
    await vi.advanceTimersByTimeAsync(2000);

    expect(execFileImpl).toHaveBeenCalledTimes(2);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('keeps onReject behavior with the new options signature', () => {
    const execFileImpl = makeExecFile([rejection('blocked by policy')]);
    const onReject = vi.fn();
    const onFail = vi.fn();
    const sendToC4 = createC4Sender({
      c4Receive: '/tmp/c4-receive.js',
      execFileImpl,
      retryDelayMs: 2000,
      logger: makeLogger(),
    });

    sendToC4('ms-teams', 'conversation-1|type:dm', 'hello', { onReject, onFail });

    expect(execFileImpl).toHaveBeenCalledTimes(1);
    // Core's text never reaches the user; no persisted array = uncertain.
    expect(onReject).toHaveBeenCalledWith(UNCERTAIN_REPLY);
    expect(onFail).not.toHaveBeenCalled();
  });
});

describe('sendToC4 session groups and rejection classes', () => {
  const run = (stdout) => {
    const execFileImpl = vi.fn((cmd, args, options, cb) => cb(new Error('rejected'), stdout));
    const onReject = vi.fn();
    const send = createC4Sender({ c4Receive: '/tmp/none/c4-receive.js', execFileImpl, logger: makeLogger(), resolveGroup: () => 'dm-x' });
    send('ms-teams', 'c|type:dm', 'hi', { onReject });
    return { execFileImpl, onReject };
  };
  const rej = (persisted) => JSON.stringify({ ok: false, error: { code: 'X', message: 'core text', persisted } });

  it('committed: onReject(null), no resend', () => {
    const { execFileImpl, onReject } = run(rej(['row']));
    expect(onReject).toHaveBeenCalledWith(null);
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it('not stored: generic notice, Core text never forwarded', () => {
    const { onReject } = run(rej([]));
    expect(onReject).toHaveBeenCalledWith(GENERIC_REJECT_REPLY);
  });

  it('no kill timeout is passed to execFile', () => {
    const { execFileImpl } = run(rej([]));
    expect(execFileImpl.mock.calls[0][2].timeout).toBeUndefined();
  });

  it('unmappable endpoint is never sent to the overall group', () => {
    const execFileImpl = vi.fn();
    const onReject = vi.fn();
    const send = createC4Sender({ c4Receive: multiSessionC4(), execFileImpl, logger: makeLogger(), resolveGroup: () => { throw new Error('bad'); } });
    send('ms-teams', 'c', 'hi', { onReject });
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith(GENERIC_REJECT_REPLY);
  });

  it('old Core (no --session-group): the group is never resolved or stored', () => {
    const execFileImpl = vi.fn((cmd, args, options, cb) => cb(null, 'ok'));
    const resolveGroup = vi.fn(() => { throw new Error('store write failed'); });
    const onReject = vi.fn();
    const send = createC4Sender({ c4Receive: '/tmp/none/c4-receive.js', execFileImpl, logger: makeLogger(), resolveGroup });
    send('ms-teams', 'c|type:dm', 'hi', { onReject });
    expect(resolveGroup).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    expect(execFileImpl.mock.calls[0][1]).not.toContain('--session-group');
  });

  it('multi-session Core: resolved group is passed', () => {
    const execFileImpl = vi.fn((cmd, args, options, cb) => cb(null, 'ok'));
    const send = createC4Sender({ c4Receive: multiSessionC4(), execFileImpl, logger: makeLogger(), resolveGroup: () => 'dm-x' });
    send('ms-teams', 'c|type:dm', 'hi', {});
    expect(execFileImpl.mock.calls[0][1].slice(-2)).toEqual(['--session-group', 'dm-x']);
  });
});
