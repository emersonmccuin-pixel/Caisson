// T3.2b — AgentsList DetailPane pod-bundle reload core (`hasNewPodFrameFor`):
// reload only for a NEW frame matching the open podId; inert otherwise.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LiveEvent } from '@pc/contracts';

import { hasNewPodFrameFor } from '../src/features/agents/pod-live-events.ts';

function podEv(entityId: string, podId: string, cursor: string): LiveEvent {
  return {
    id: `pod-${cursor}`,
    cursor,
    scope: 'project',
    projectId: 'p1',
    type: 'pod.changed',
    entity: 'pod',
    entityId: entityId as never,
    version: null,
    createdAt: 1,
    payload: { change: 'updated', podId } as never,
  };
}

test('reloads for a new frame matching the open pod', () => {
  const seen = new Map<string, number | string>();
  assert.equal(hasNewPodFrameFor([podEv('pod-1', 'pod-1', 'c1')], 'pod-1', seen), true);
});

test('does NOT reload for a frame of a different pod', () => {
  const seen = new Map<string, number | string>();
  assert.equal(hasNewPodFrameFor([podEv('pod-2', 'pod-2', 'c1')], 'pod-1', seen), false);
});

test('does NOT re-reload for the same frame on array re-identity', () => {
  const seen = new Map<string, number | string>();
  assert.equal(hasNewPodFrameFor([podEv('pod-1', 'pod-1', 'c1')], 'pod-1', seen), true);
  assert.equal(hasNewPodFrameFor([podEv('pod-1', 'pod-1', 'c1')], 'pod-1', seen), false);
});

test('a newer frame for the open pod reloads again', () => {
  const seen = new Map<string, number | string>();
  assert.equal(hasNewPodFrameFor([podEv('pod-1', 'pod-1', 'c1')], 'pod-1', seen), true);
  assert.equal(hasNewPodFrameFor([podEv('pod-1', 'pod-1', 'c2')], 'pod-1', seen), true);
});
