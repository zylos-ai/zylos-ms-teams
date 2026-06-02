export function createInboundDebouncer({
  delayMs = 0,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  mergeValues = (previous, next) => next,
} = {}) {
  const pending = new Map();
  const delay = Math.max(0, Number(delayMs) || 0);

  function schedule(key, value, dispatch) {
    if (!delay) {
      dispatch(value);
      return false;
    }

    const existing = pending.get(key);
    const mergedValue = existing ? mergeValues(existing.value, value) : value;
    if (existing) clearTimer(existing.timer);

    const timer = setTimer(() => {
      const entry = pending.get(key);
      pending.delete(key);
      if (entry) entry.dispatch(entry.value);
    }, delay);

    pending.set(key, {
      value: mergedValue,
      dispatch,
      timer,
      updatedAt: now(),
    });
    return true;
  }

  function cancel(key) {
    const existing = pending.get(key);
    if (!existing) return false;
    clearTimer(existing.timer);
    pending.delete(key);
    return true;
  }

  function flush(key) {
    const existing = pending.get(key);
    if (!existing) return false;
    clearTimer(existing.timer);
    pending.delete(key);
    existing.dispatch(existing.value);
    return true;
  }

  return {
    schedule,
    cancel,
    flush,
    size: () => pending.size,
    pendingKeys: () => Array.from(pending.keys()),
  };
}
