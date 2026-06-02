import { describe, it, expect } from 'vitest';
import { parseCardMarker } from '../src/lib/card-send.js';

describe('CARD send marker', () => {
  it('parses adaptive card marker JSON', () => {
    const card = parseCardMarker('[CARD:{"type":"AdaptiveCard","body":[{"type":"TextBlock","text":"Hi"}]}]');

    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.content.body[0].text).toBe('Hi');
  });

  it('returns null for regular text', () => {
    expect(parseCardMarker('hello')).toBe(null);
  });
});
