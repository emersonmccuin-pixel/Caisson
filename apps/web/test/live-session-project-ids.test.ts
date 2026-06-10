// Unit tests for the deriveActiveSessionProjectIds pure derivation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveActiveSessionProjectIds,
  isLiveRuntimeHealth,
} from '../src/hooks/live-session-project-ids.ts';
import type { OrchestratorRuntimeHealth } from '../src/features/runtime/types.ts';
import type { WsEnvelope } from '../src/features/runtime/ws-types.ts';

// Helper: build a runtime-state envelope with a given health value.
function runtimeState(
  projectId: string,
  health: OrchestratorRuntimeHealth,
): WsEnvelope {
  return { type: 'runtime-state', projectId, health } as WsEnvelope;
}

// ── isLiveRuntimeHealth ──────────────────────────────────────────────────────

test('isLiveRuntimeHealth: spawning → true', () => {
  assert.equal(isLiveRuntimeHealth(runtimeState('p1', 'spawning')), true);
});

test('isLiveRuntimeHealth: ready → true', () => {
  assert.equal(isLiveRuntimeHealth(runtimeState('p1', 'ready')), true);
});

test('isLiveRuntimeHealth: busy → true', () => {
  assert.equal(isLiveRuntimeHealth(runtimeState('p1', 'busy')), true);
});

test('isLiveRuntimeHealth: respawning → true', () => {
  assert.equal(isLiveRuntimeHealth(runtimeState('p1', 'respawning')), true);
});

test('isLiveRuntimeHealth: not_spawned → false', () => {
  assert.equal(isLiveRuntimeHealth(runtimeState('p1', 'not_spawned')), false);
});

test('isLiveRuntimeHealth: exited → false', () => {
  assert.equal(isLiveRuntimeHealth(runtimeState('p1', 'exited')), false);
});

test('isLiveRuntimeHealth: failed_resume → false', () => {
  assert.equal(isLiveRuntimeHealth(runtimeState('p1', 'failed_resume')), false);
});

test('isLiveRuntimeHealth: provider_missing → false', () => {
  assert.equal(isLiveRuntimeHealth(runtimeState('p1', 'provider_missing')), false);
});

test('isLiveRuntimeHealth: non runtime-state envelope → false', () => {
  assert.equal(
    isLiveRuntimeHealth({ type: 'session-changed', projectId: 'p1' } as WsEnvelope),
    false,
  );
});

// ── deriveActiveSessionProjectIds ────────────────────────────────────────────

test('empty streams → empty set', () => {
  const result = deriveActiveSessionProjectIds([], []);
  assert.equal(result.size, 0);
});

test('ready health in active events → project in set', () => {
  const result = deriveActiveSessionProjectIds(
    [runtimeState('p1', 'ready')],
    [],
  );
  assert.equal(result.has('p1'), true);
  assert.equal(result.size, 1);
});

test('not_spawned health → project NOT in set', () => {
  const result = deriveActiveSessionProjectIds(
    [runtimeState('p1', 'not_spawned')],
    [],
  );
  assert.equal(result.has('p1'), false);
  assert.equal(result.size, 0);
});

test('exited health → project NOT in set', () => {
  const result = deriveActiveSessionProjectIds(
    [runtimeState('p1', 'exited')],
    [],
  );
  assert.equal(result.has('p1'), false);
});

test('multiple projects, mixed health values', () => {
  const result = deriveActiveSessionProjectIds(
    [
      runtimeState('p1', 'busy'),
      runtimeState('p2', 'exited'),
      runtimeState('p3', 'spawning'),
    ],
    [],
  );
  assert.equal(result.has('p1'), true);
  assert.equal(result.has('p2'), false);
  assert.equal(result.has('p3'), true);
  assert.equal(result.size, 2);
});

test('background overrides active: process exits after user switches away', () => {
  // Active events saw a live runtime; background reports it has since exited.
  const result = deriveActiveSessionProjectIds(
    [runtimeState('p1', 'ready')],
    [runtimeState('p1', 'exited')],
  );
  assert.equal(result.has('p1'), false);
});

test('live runtime only visible in background stream', () => {
  const result = deriveActiveSessionProjectIds(
    [],
    [runtimeState('p2', 'busy')],
  );
  assert.equal(result.has('p2'), true);
});

test('last runtime-state per project wins — process stopped', () => {
  const result = deriveActiveSessionProjectIds(
    [
      runtimeState('p1', 'ready'),
      runtimeState('p1', 'exited'), // later envelope: process stopped
    ],
    [],
  );
  assert.equal(result.has('p1'), false);
});

test('last runtime-state per project wins — process (re-)started', () => {
  const result = deriveActiveSessionProjectIds(
    [
      runtimeState('p1', 'exited'),
      runtimeState('p1', 'spawning'), // later: spawning again
    ],
    [],
  );
  assert.equal(result.has('p1'), true);
});

test('boot case: project with only not_spawned runtime-state is NOT live', () => {
  // On a fresh app launch the connect-snapshot sends not_spawned for every
  // project that has never been started — none should show the underline.
  const result = deriveActiveSessionProjectIds(
    [
      runtimeState('p1', 'not_spawned'),
      runtimeState('p2', 'not_spawned'),
    ],
    [],
  );
  assert.equal(result.size, 0);
});

test('non runtime-state envelopes are ignored', () => {
  const result = deriveActiveSessionProjectIds(
    [
      { type: 'event', projectId: 'p1', event: {} } as WsEnvelope,
      { type: 'session-changed', projectId: 'p1', session: { status: 'active' } } as WsEnvelope,
    ],
    [],
  );
  assert.equal(result.size, 0);
});

test('missing projectId in envelope is skipped', () => {
  const result = deriveActiveSessionProjectIds(
    [{ type: 'runtime-state', projectId: null, health: 'ready' } as WsEnvelope],
    [],
  );
  assert.equal(result.size, 0);
});
