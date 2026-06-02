import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConversationReference: vi.fn(),
  acquireTokenForScope: vi.fn(),
}));

vi.mock('../src/lib/conversation-store.js', () => ({
  getConversationReference: mocks.getConversationReference,
}));

vi.mock('../src/lib/graph.js', () => ({
  isGraphEnabled: vi.fn(() => false),
  acquireTokenForScope: mocks.acquireTokenForScope,
}));

import { registerRoutes } from '../src/routes.js';

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

function baseDeps(overrides = {}) {
  return {
    internalToken: 'test-token',
    teamsApp: { send: vi.fn() },
    botName: 'Zylos',
    reactionContextCache: new Map(),
    pendingReactions: new Map(),
    persistReactionCache: vi.fn(),
    recordHistoryEntry: vi.fn(),
    handleChannelNotification: vi.fn(),
    stopTyping: vi.fn(),
    ...overrides,
  };
}

describe('internal send route', () => {
  const realFetch = globalThis.fetch;
  let server;

  beforeEach(() => {
    mocks.getConversationReference.mockReset();
    mocks.acquireTokenForScope.mockReset();
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (server) {
      await new Promise(resolve => server.close(resolve));
      server = null;
    }
  });

  it('returns Bot Connector activity id and records history when requested', async () => {
    const deps = baseDeps();
    mocks.getConversationReference.mockResolvedValue({
      serviceUrl: 'https://service.example',
    });
    mocks.acquireTokenForScope.mockResolvedValue('bot-token');
    globalThis.fetch = vi.fn(async (url, options) => {
      if (String(url).startsWith('http://127.0.0.1:')) {
        return realFetch(url, options);
      }
      return new Response(JSON.stringify({ id: 'activity-123' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });

    const app = express();
    registerRoutes(app, deps);
    server = await listen(app);
    const { port } = server.address();

    const response = await realFetch(`http://127.0.0.1:${port}/internal/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': 'test-token',
      },
      body: JSON.stringify({
        conversationId: 'conv-1;messageid=parent-1',
        text: 'hello',
        type: 'channel',
        replyToId: 'parent-1',
        returnActivityId: true,
      }),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      activityId: 'activity-123',
    });
    expect(response.status).toBe(200);
    expect(mocks.acquireTokenForScope).toHaveBeenCalledWith('botframework');
    expect(deps.teamsApp.send).not.toHaveBeenCalled();
    expect(deps.recordHistoryEntry).toHaveBeenCalledWith('conv-1', expect.objectContaining({
      message_id: 'activity-123',
      user_id: 'bot',
      user_name: 'Zylos',
      text: 'hello',
    }));
  });
});
