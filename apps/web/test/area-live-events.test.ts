// T3.2b — KanbanBoard/WorkItemsTable area-delete refetch core.
// Pins `hasNewDeletedAreaFrame`: fire once per NEW deleted frame; inert on
// created/patched/reordered and on a re-identified-but-unchanged array.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LiveEvent } from '@pc/contracts';

import { hasNewDeletedAreaFrame } from '../src/features/areas/area-live-events.ts';

function areaEv(
  entityId: string | null,
  reason: 'created' | 'patched' | 'deleted' | 'reordered',
  version: number | null,
  cursor: string,
): LiveEvent {
  return {
    id: `id-${entityId}-${cursor}`,
    cursor,
    scope: 'project',
    projectId: 'p1',
    type: 'area.changed',
    entity: 'area',
    entityId: entityId as never,
    version,
    createdAt: 1,
    payload: { reason } as never,
  };
}

test('fires once on a new deleted frame and records its marker', () => {
  const seen = new Map<string, number | string>();
  assert.equal(hasNewDeletedAreaFrame([areaEv('a1', 'deleted', null, 'c1')], seen), true);
  assert.equal(seen.get('a1'), 'c1');
});

test('does NOT re-fire for the same deleted frame (array re-identity)', () => {
  const seen = new Map<string, number | string>();
  const list = [areaEv('a1', 'deleted', null, 'c1')];
  assert.equal(hasNewDeletedAreaFrame(list, seen), true);
  // a fresh array with the SAME marker → no re-fire.
  assert.equal(hasNewDeletedAreaFrame([areaEv('a1', 'deleted', null, 'c1')], seen), false);
});

test('inert on created / patched / reordered frames', () => {
  const seen = new Map<string, number | string>();
  assert.equal(hasNewDeletedAreaFrame([areaEv('a1', 'created', null, 'c1')], seen), false);
  assert.equal(hasNewDeletedAreaFrame([areaEv('a2', 'patched', null, 'c2')], seen), false);
  assert.equal(hasNewDeletedAreaFrame([areaEv('a3', 'reordered', null, 'c3')], seen), false);
});

test('a later deleted frame for the same id (new marker) re-fires', () => {
  const seen = new Map<string, number | string>();
  assert.equal(hasNewDeletedAreaFrame([areaEv('a1', 'patched', null, 'c1')], seen), false);
  assert.equal(hasNewDeletedAreaFrame([areaEv('a1', 'deleted', null, 'c2')], seen), true);
});

test('frames with no entityId are skipped', () => {
  const seen = new Map<string, number | string>();
  assert.equal(hasNewDeletedAreaFrame([areaEv(null, 'deleted', null, 'c1')], seen), false);
});
