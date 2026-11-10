import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createC4Sender, GENERIC_REJECT_REPLY, UNCERTAIN_REPLY } from '../src/lib/c4.js';

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

  it('fires onFail when both send attempts fail', async () => {
    const execFileImpl = makeExecFile([failure(), failure('still down')]);
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
    const execFileImpl = makeExecFile([failure(), { stdout: 'ok' }]);
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
    const send = createC4Sender({ execFileImpl, logger: makeLogger(), resolveGroup: () => { throw new Error('bad'); } });
    send('ms-teams', 'c', 'hi', { onReject });
    expect(execFileImpl).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith(GENERIC_REJECT_REPLY);
  });
});
