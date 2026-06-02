import { describe, it, expect } from 'vitest';
import {
  activityDedupKey,
  editedMessageText,
  deletedMessageText,
  extractCardActionPayload,
  cardActionMessage,
} from '../src/lib/activity-events.js';

describe('activity event helpers', () => {
  it('builds dedup keys with activity id and timestamp', () => {
    expect(activityDedupKey({ id: 'a1', timestamp: '2026-06-02T00:00:00Z' }, 'update'))
      .toBe('a1:update:2026-06-02T00:00:00Z');
  });

  it('formats edit and delete notifications', () => {
    expect(editedMessageText('updated body')).toBe('[edited] updated body');
    expect(deletedMessageText('Alice')).toBe('[message deleted by Alice]');
  });

  it('extracts adaptive card action payloads', () => {
    expect(extractCardActionPayload({ value: { action: { data: { choice: 'yes' } } } }))
      .toEqual({ choice: 'yes' });
    expect(extractCardActionPayload({ value: { data: { id: 1 } } })).toEqual({ id: 1 });
  });

  it('formats card action messages', () => {
    expect(cardActionMessage('Alice', { choice: 'yes' }))
      .toBe('[Card Action from Alice] {"choice":"yes"}');
  });
});
