import { describe, expect, it } from 'vitest';
import { buildProgressText, nextProgressText, normalizeProgressStages } from '../src/lib/progress-stages.js';

describe('progress stages', () => {
  it('normalizes and caps configured stages', () => {
    expect(normalizeProgressStages([' One ', '', null, 'Two'])).toEqual(['One', 'Two']);
    expect(normalizeProgressStages(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('builds a text progress card', () => {
    expect(buildProgressText(['Queued', 'Working', 'Sending'], 1)).toBe('[x] Queued\n[>] Working\n[ ] Sending');
  });

  it('advances to the next progress stage', () => {
    expect(nextProgressText(['Queued', 'Working'], -1)).toEqual({ index: 0, text: '[>] Queued\n[ ] Working' });
    expect(nextProgressText(['Queued', 'Working'], 0)).toEqual({ index: 1, text: '[x] Queued\n[>] Working' });
    expect(nextProgressText(['Queued', 'Working'], 1)).toEqual({ index: 1, text: '[x] Queued\n[>] Working' });
  });
});
