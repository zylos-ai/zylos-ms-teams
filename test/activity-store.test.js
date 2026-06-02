import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordConversationActivity, warningForActiveConversation } from '../src/lib/activity-store.js';

describe('conversation activity store', () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msteams-activity-'));
    filePath = path.join(dir, 'activity.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('warns when an admin change affects a recently active conversation', () => {
    recordConversationActivity({
      conversationId: 'channel-1;messageid=thread-1',
      type: 'channel',
      name: 'General',
      at: '2026-06-02T10:00:00.000Z',
    }, filePath);

    const warning = warningForActiveConversation('channel-1', 'removing channel configuration', {
      filePath,
      now: new Date('2026-06-02T11:00:00.000Z').getTime(),
    });

    expect(warning).toContain('removing channel configuration');
    expect(warning).toContain('General');
  });

  it('does not warn for stale activity', () => {
    recordConversationActivity({
      conversationId: 'channel-1',
      type: 'channel',
      at: '2026-06-01T00:00:00.000Z',
    }, filePath);

    const warning = warningForActiveConversation('channel-1', 'removing channel configuration', {
      filePath,
      now: new Date('2026-06-02T10:00:00.000Z').getTime(),
    });

    expect(warning).toBe('');
  });
});
