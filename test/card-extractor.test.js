import { describe, it, expect } from 'vitest';
import { extractCardText, hasCardAttachments } from '../src/lib/card-extractor.js';

describe('card extraction', () => {
  it('extracts adaptive card text, facts, inputs, and image alt text', () => {
    const text = extractCardText([{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        body: [
          { type: 'TextBlock', text: 'Approval needed' },
          { type: 'FactSet', facts: [{ title: 'Amount', value: '$42' }] },
          { type: 'Input.Text', id: 'comment', label: 'Comment', value: 'Looks good' },
          { type: 'ColumnSet', columns: [{ type: 'Column', items: [{ type: 'Image', altText: 'receipt image' }] }] },
        ],
      },
    }]);

    expect(text).toContain('[Adaptive Card: Approval needed]');
    expect(text).toContain('Amount: $42');
    expect(text).toContain('Comment: Looks good');
    expect(text).toContain('receipt image');
  });

  it('extracts hero cards', () => {
    const text = extractCardText([{
      contentType: 'application/vnd.microsoft.card.hero',
      content: { title: 'Hero', subtitle: 'Sub', text: '<b>Body</b>', buttons: [{ title: 'Open', value: 'https://x.test' }] },
    }]);

    expect(text).toContain('[Hero Card: Hero]');
    expect(text).toContain('Sub');
    expect(text).toContain('**Body**');
    expect(text).toContain('Open: https://x.test');
  });

  it('detects supported card attachments', () => {
    expect(hasCardAttachments([{ contentType: 'application/vnd.microsoft.card.adaptive' }])).toBe(true);
    expect(hasCardAttachments([{ contentType: 'image/png' }])).toBe(false);
  });
});
