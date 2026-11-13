import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConversationReference: vi.fn(),
  acquireTokenForScope: vi.fn(),
  config: {
    enabled: true,
    replyStyle: 'thread',
    channels: {},
    groups: {},
    message: { context_messages: 10 },
  },
}));

vi.mock('../src/lib/conversation-store.js', () => ({
  getConversationReference: mocks.getConversationReference,
}));

vi.mock('../src/lib/graph.js', () => ({
  isGraphEnabled: vi.fn(() => false),
  acquireTokenForScope: mocks.acquireTokenForScope,
}));

vi.mock('../src/lib/config.js', async () => {
  const actual = await vi.importActual('../src/lib/config.js');
  return {
    ...actual,
    getConfig: () => mocks.config,
    getCredentials: () => ({ appId: '', appPassword: '', tenantId: '' }),
    getPublicUrl: () => '',
  };
});

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
    mocks.config = {
      enabled: true,
      replyStyle: 'thread',
      channels: {},
      groups: {},
      message: { context_messages: 10 },
    };
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
    expect(deps.recordHistoryEntry).toHaveBeenCalledWith('conv-1;messageid=parent-1', expect.objectContaining({
      message_id: 'activity-123',
      user_id: 'bot',
      user_name: 'Zylos',
      text: 'hello',
    }));
  });

  it('omits replyToId when route replyStyle is new', async () => {
    mocks.config = {
      enabled: true,
      replyStyle: 'thread',
      channels: { 'conv-1': { replyStyle: 'new' } },
      groups: {},
      message: { context_messages: 10 },
    };
    const deps = baseDeps();
    mocks.getConversationReference.mockResolvedValue({
      serviceUrl: 'https://service.example',
    });
    mocks.acquireTokenForScope.mockResolvedValue('bot-token');
    let postedActivity;
    globalThis.fetch = vi.fn(async (url, options) => {
      if (String(url).startsWith('http://127.0.0.1:')) {
        return realFetch(url, options);
      }
      postedActivity = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: 'activity-456' }), {
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
        conversationId: 'conv-1',
        text: 'hello',
        type: 'channel',
        replyToId: 'parent-1',
        returnActivityId: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(postedActivity).not.toHaveProperty('replyToId');
  });

  describe('requireReply (outbound owner-reply exception)', () => {
    async function post(body) {
      const deps = baseDeps();
      const app = express();
      registerRoutes(app, deps);
      server = await listen(app);
      const { port } = server.address();
      const response = await realFetch(`http://127.0.0.1:${port}/internal/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'test-token' },
        body: JSON.stringify(body),
      });
      return { deps, response };
    }

    it('keeps replyToId even when replyStyle is new', async () => {
      mocks.config = { ...mocks.config, channels: { 'conv-1': { replyStyle: 'new' } } };
      mocks.getConversationReference.mockResolvedValue({ serviceUrl: 'https://service.example' });
      mocks.acquireTokenForScope.mockResolvedValue('bot-token');
      let sent;
      globalThis.fetch = vi.fn(async (url, options) => {
        if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
        sent = JSON.parse(options.body);
        return new Response(JSON.stringify({ id: 'a1' }), { status: 201, headers: { 'content-type': 'application/json' } });
      });
      const { deps, response } = await post({ conversationId: 'conv-1;messageid=1', text: 'hi', type: 'channel', replyToId: 'm1', requireReply: true });
      expect(response.status).toBe(200);
      expect(sent.replyToId).toBe('m1');
      expect(deps.teamsApp.send).not.toHaveBeenCalled();
    });

    it('refuses instead of sending a plain message when it cannot reply', async () => {
      mocks.getConversationReference.mockResolvedValue({ serviceUrl: 'https://service.example' });
      for (const body of [
        { conversationId: 'g', text: 'hi', type: 'group', replyToId: 'm1', requireReply: true },
        { conversationId: 'c;messageid=1', text: 'hi', type: 'channel', requireReply: true },
      ]) {
        const { deps, response } = await post(body);
        expect(response.status).toBe(400);
        expect(deps.teamsApp.send).not.toHaveBeenCalled();
        await new Promise(resolve => server.close(resolve));
        server = null;
      }
    });
  });
});
