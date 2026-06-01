import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveEventFrame,
  isHostHealthChangedLivePayload,
  isHostHealthSnapshot,
  isLiveEvent,
  isLiveEventFrame,
  isLiveEventTypeName,
  type HostHealthChangedLivePayload,
  type LiveEvent,
} from '../src/index.ts';

test('host-health entity + type are registered', () => {
  assert.equal(isLiveEventTypeName('host-health.changed'), true);
});

test('a host-health.changed global frame round-trips isLiveEvent/isLiveEventFrame', () => {
  const event: LiveEvent<HostHealthChangedLivePayload> = {
    id: '01HOSTHEALTH',
    cursor: '42',
    scope: 'global',
    projectId: null,
    type: 'host-health.changed',
    entity: 'host-health',
    entityId: 'host-health',
    version: null,
    createdAt: Date.now(),
    payload: {
      health: { state: 'connected', hostId: 'h1', pid: 123, since: Date.now() },
    },
  };
  assert.equal(isLiveEvent(event), true);
  assert.equal(isLiveEventFrame(buildLiveEventFrame(event)), true);
});

test('isHostHealthSnapshot guards all three states', () => {
  assert.equal(
    isHostHealthSnapshot({ state: 'connected', hostId: 'h', pid: 1, since: 1 }),
    true,
  );
  assert.equal(
    isHostHealthSnapshot({ state: 'down', hostId: null, pid: null, lastError: 'x', since: 1 }),
    true,
  );
  assert.equal(isHostHealthSnapshot({ state: 'bogus', hostId: null, pid: null, since: 1 }), false);
  assert.equal(isHostHealthSnapshot({ state: 'down', hostId: 1, pid: null, since: 1 }), false);
});

test('isHostHealthChangedLivePayload guards the payload', () => {
  assert.equal(
    isHostHealthChangedLivePayload({
      health: { state: 'reconnecting', hostId: null, pid: null, lastError: 'boom', since: 1 },
    }),
    true,
  );
  assert.equal(isHostHealthChangedLivePayload({ health: {} }), false);
  assert.equal(isHostHealthChangedLivePayload({}), false);
});
