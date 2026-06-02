import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createC4Sender } from '../src/lib/c4.js';

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

    sendToC4('ms-teams', 'conversation-1', 'hello', { onFail });
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

    sendToC4('ms-teams', 'conversation-1', 'hello', { onFail });
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

    sendToC4('ms-teams', 'conversation-1', 'hello', { onFail });
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

    sendToC4('ms-teams', 'conversation-1', 'hello', { onReject, onFail });

    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith('blocked by policy');
    expect(onFail).not.toHaveBeenCalled();
  });
});
