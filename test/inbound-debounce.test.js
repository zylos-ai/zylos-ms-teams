import { describe, expect, it, vi } from 'vitest';
import { createInboundDebouncer } from '../src/lib/inbound-debounce.js';

describe('inbound debouncer', () => {
  it('dispatches immediately when delay is disabled', () => {
    const debouncer = createInboundDebouncer({ delayMs: 0 });
    const dispatch = vi.fn();

    const scheduled = debouncer.schedule('conv-1', 'hello', dispatch);

    expect(scheduled).toBe(false);
    expect(dispatch).toHaveBeenCalledWith('hello');
    expect(debouncer.size()).toBe(0);
  });

  it('keeps only the latest value per key', async () => {
    vi.useFakeTimers();
    const debouncer = createInboundDebouncer({ delayMs: 100 });
    const dispatch = vi.fn();

    expect(debouncer.schedule('conv-1', 'first', dispatch)).toBe(true);
    expect(debouncer.schedule('conv-1', 'second', dispatch)).toBe(true);
    expect(debouncer.size()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('second');
    expect(debouncer.size()).toBe(0);
    vi.useRealTimers();
  });

  it('can flush pending values', () => {
    vi.useFakeTimers();
    const debouncer = createInboundDebouncer({ delayMs: 1000 });
    const dispatch = vi.fn();

    debouncer.schedule('conv-1', 'pending', dispatch);
    expect(debouncer.flush('conv-1')).toBe(true);
    expect(dispatch).toHaveBeenCalledWith('pending');
    expect(debouncer.flush('conv-1')).toBe(false);
    vi.useRealTimers();
  });

  it('can flush all pending values', () => {
    vi.useFakeTimers();
    const debouncer = createInboundDebouncer({ delayMs: 1000 });
    const dispatch = vi.fn();

    debouncer.schedule('conv-1', 'one', dispatch);
    debouncer.schedule('conv-2', 'two', dispatch);

    expect(debouncer.flushAll()).toBe(2);
    expect(dispatch).toHaveBeenCalledWith('one');
    expect(dispatch).toHaveBeenCalledWith('two');
    expect(debouncer.size()).toBe(0);
    vi.useRealTimers();
  });

  it('can merge pending values for the same key', async () => {
    vi.useFakeTimers();
    const debouncer = createInboundDebouncer({
      delayMs: 100,
      mergeValues: (previous, next) => `${previous}\n${next}`,
    });
    const dispatch = vi.fn();

    debouncer.schedule('conv-1', 'first', dispatch);
    debouncer.schedule('conv-1', 'second', dispatch);
    await vi.advanceTimersByTimeAsync(100);

    expect(dispatch).toHaveBeenCalledWith('first\nsecond');
    vi.useRealTimers();
  });

  it('can preserve callbacks while merging values', async () => {
    vi.useFakeTimers();
    const onFail = vi.fn();
    const debouncer = createInboundDebouncer({
      delayMs: 100,
      mergeValues: (previous, next) => ({
        ...next,
        msg: `${previous.msg}\n${next.msg}`,
        callbacks: previous.callbacks || next.callbacks,
      }),
    });
    const dispatch = vi.fn();

    debouncer.schedule('conv-1', { msg: 'first', callbacks: { onFail } }, dispatch);
    debouncer.schedule('conv-1', { msg: 'second' }, dispatch);
    await vi.advanceTimersByTimeAsync(100);

    expect(dispatch).toHaveBeenCalledWith({
      msg: 'first\nsecond',
      callbacks: { onFail },
    });
    vi.useRealTimers();
  });
});
