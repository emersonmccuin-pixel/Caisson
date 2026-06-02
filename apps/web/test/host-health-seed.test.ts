// T2.3-C — cold-load HTTP seed for the live store. `seedEvents([...])` merges
// raw LiveEvents with the SAME (entity,entityId)+version dedup as applyEnvelope:
// a stale-version raw event is dropped, a newer one wins, and a null-version
// entity (host-health) is last-write-wins. Plus the HostHealthBanner render
// matrix (pure decision function — the web runner has no jsdom).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { HostHealthSnapshot, LiveEvent } from '@pc/contracts';

import { useLiveStore } from '../src/store/live-store.ts';
import { pickHostHealthBanner } from '../src/features/system/host-health-banner-view.ts';

function hostHealthEvent(
  over: Partial<LiveEvent> & { state?: HostHealthSnapshot['state'] } = {},
): LiveEvent {
  const { state = 'connected', ...rest } = over;
  const health: HostHealthSnapshot =
    state === 'connected'
      ? { state, hostId: 'h1', pid: 123, since: 1 }
      : { state, hostId: null, pid: null, lastError: 'boom', since: 1 };
  return {
    id: 'id-1',
    cursor: '1',
    scope: 'global',
    projectId: null,
    type: 'host-health.changed',
    entity: 'host-health',
    entityId: 'host-health',
    version: null,
    createdAt: 1,
    payload: { health },
    ...rest,
  } as LiveEvent;
}

function workItemEvent(over: Partial<LiveEvent>): LiveEvent {
  return {
    id: 'wi',
    cursor: '1',
    scope: 'project',
    projectId: 'p1',
    type: 'work-item.changed',
    entity: 'work-item',
    entityId: 'wi-1',
    version: 1,
    createdAt: 1,
    payload: {},
    ...over,
  } as LiveEvent;
}

test('seedEvents merges a global host-health event into the store', () => {
  useLiveStore.getState().clearAll();
  useLiveStore.getState().seedEvents([hostHealthEvent({ state: 'connected' })]);
  const got = useLiveStore.getState().byKey.get('host-health::host-health');
  assert.ok(got);
  assert.equal(got.type, 'host-health.changed');
});

test('seedEvents: null-version events are last-write-wins (later seed overwrites)', () => {
  useLiveStore.getState().clearAll();
  const store = useLiveStore.getState();
  store.seedEvents([hostHealthEvent({ id: 'a', cursor: '1', state: 'connected' })]);
  store.seedEvents([hostHealthEvent({ id: 'b', cursor: '2', state: 'reconnecting' })]);
  const got = useLiveStore.getState().byKey.get('host-health::host-health') as LiveEvent;
  assert.equal(got.id, 'b'); // newer wins (null version → LWW)
});

test('seedEvents: a stale numeric version is dropped; a newer one wins', () => {
  useLiveStore.getState().clearAll();
  const store = useLiveStore.getState();
  store.seedEvents([workItemEvent({ id: 'v2', version: 2 })]);
  // Stale (version 1 <= held 2) — dropped.
  store.seedEvents([workItemEvent({ id: 'v1', version: 1 })]);
  let got = useLiveStore.getState().byKey.get('work-item::wi-1') as LiveEvent;
  assert.equal(got.id, 'v2');
  // Newer (version 3) — applies.
  store.seedEvents([workItemEvent({ id: 'v3', version: 3 })]);
  got = useLiveStore.getState().byKey.get('work-item::wi-1') as LiveEvent;
  assert.equal(got.id, 'v3');
});

test('seedEvents: a null-entityId event is dropped (same guard as applyEnvelope)', () => {
  useLiveStore.getState().clearAll();
  useLiveStore.getState().seedEvents([hostHealthEvent({ entityId: null })]);
  assert.equal(useLiveStore.getState().byKey.size, 0);
});

// ── HostHealthBanner render matrix ─────────────────────────────────────────

test('banner: connected → null', () => {
  assert.equal(pickHostHealthBanner([hostHealthEvent({ state: 'connected' })]), null);
});

test('banner: no frame → null', () => {
  assert.equal(pickHostHealthBanner([]), null);
});

test('banner: reconnecting → reconnecting strip', () => {
  const view = pickHostHealthBanner([hostHealthEvent({ state: 'reconnecting' })]);
  assert.ok(view);
  assert.equal(view.tone, 'reconnecting');
  assert.match(view.message, /Reconnecting/);
});

test('banner: down → down strip', () => {
  const view = pickHostHealthBanner([hostHealthEvent({ state: 'down' })]);
  assert.ok(view);
  assert.equal(view.tone, 'down');
  assert.match(view.message, /unreachable/);
});

test('banner: reads the LATEST frame', () => {
  const view = pickHostHealthBanner([
    hostHealthEvent({ id: 'a', state: 'down' }),
    hostHealthEvent({ id: 'b', state: 'connected' }),
  ]);
  assert.equal(view, null); // latest is connected
});
