import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeConfigWithDefaults, resolveRouteConfig } from '../src/lib/config.js';

// --- mergeConfigWithDefaults ---

test('returns defaults when called with empty object', () => {
  const config = mergeConfigWithDefaults({});
  assert.equal(config.enabled, true);
  assert.equal(config.port, 3978);
  assert.equal(config.dmPolicy, 'owner');
  assert.equal(config.groupPolicy, 'allowlist');
  assert.equal(config.owner.bound, false);
  assert.equal(config.message.context_messages, 10);
});

test('user values override defaults', () => {
  const config = mergeConfigWithDefaults({
    port: 4000,
    dmPolicy: 'open',
  });
  assert.equal(config.port, 4000);
  assert.equal(config.dmPolicy, 'open');
  assert.equal(config.groupPolicy, 'allowlist');
});

test('nested owner is deep-merged', () => {
  const config = mergeConfigWithDefaults({
    owner: { bound: true, aadObjectId: 'abc' }
  });
  assert.equal(config.owner.bound, true);
  assert.equal(config.owner.aadObjectId, 'abc');
  assert.equal(config.owner.name, '');
});

test('nested message is deep-merged', () => {
  const config = mergeConfigWithDefaults({
    message: { context_messages: 20 }
  });
  assert.equal(config.message.context_messages, 20);
});

test('teamOverrides defaults to empty object', () => {
  const config = mergeConfigWithDefaults({});
  assert.deepEqual(config.teamOverrides, {});
});

test('preserves teamOverrides from input', () => {
  const overrides = { 'team-1': { requireMention: false } };
  const config = mergeConfigWithDefaults({ teamOverrides: overrides });
  assert.deepEqual(config.teamOverrides, overrides);
});

// --- resolveRouteConfig ---

test('returns global defaults when no team overrides exist', () => {
  const activity = { channelData: { team: { id: 'team-1' } }, conversation: { id: 'conv-1' } };
  const config = { teamOverrides: {} };
  const route = resolveRouteConfig(activity, config);
  assert.equal(route.requireMention, true);
  assert.equal(route.replyStyle, 'top-level');
  assert.deepEqual(route.allowFrom, []);
});

test('applies team-level overrides', () => {
  const activity = { channelData: { team: { id: 'team-1' } }, conversation: { id: 'conv-1' } };
  const config = {
    teamOverrides: {
      'team-1': { requireMention: false, replyStyle: 'thread' }
    }
  };
  const route = resolveRouteConfig(activity, config);
  assert.equal(route.requireMention, false);
  assert.equal(route.replyStyle, 'thread');
});

test('channel overrides take precedence over team overrides', () => {
  const activity = { channelData: { team: { id: 'team-1' } }, conversation: { id: 'chan-1' } };
  const config = {
    teamOverrides: {
      'team-1': {
        requireMention: false,
        replyStyle: 'thread',
        channels: {
          'chan-1': { requireMention: true, replyStyle: 'inline' }
        }
      }
    }
  };
  const route = resolveRouteConfig(activity, config);
  assert.equal(route.requireMention, true);
  assert.equal(route.replyStyle, 'inline');
});

test('partial channel override inherits remaining from team', () => {
  const activity = { channelData: { team: { id: 'team-1' } }, conversation: { id: 'chan-1' } };
  const config = {
    teamOverrides: {
      'team-1': {
        requireMention: false,
        replyStyle: 'thread',
        channels: {
          'chan-1': { replyStyle: 'inline' }
        }
      }
    }
  };
  const route = resolveRouteConfig(activity, config);
  assert.equal(route.requireMention, false);
  assert.equal(route.replyStyle, 'inline');
});

test('allowFrom array from team config is applied', () => {
  const activity = { channelData: { team: { id: 'team-1' } }, conversation: { id: 'conv-1' } };
  const config = {
    teamOverrides: {
      'team-1': { allowFrom: ['user-a', 'user-b'] }
    }
  };
  const route = resolveRouteConfig(activity, config);
  assert.deepEqual(route.allowFrom, ['user-a', 'user-b']);
});

test('reads teamId from alternate channelData fields', () => {
  const activity = { channelData: { teamsTeamId: 'team-2' }, conversation: { id: 'conv-1' } };
  const config = {
    teamOverrides: {
      'team-2': { requireMention: false }
    }
  };
  const route = resolveRouteConfig(activity, config);
  assert.equal(route.requireMention, false);
});
