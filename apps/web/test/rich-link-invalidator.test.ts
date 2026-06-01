// T3.1 — the rich-link invalidator's version-keyed eviction core
// (`collectEvictions`). The full hook is store-driven (rebuild-proof); this
// pins the pure decision: evict an entity exactly once per NEW marker (its
// `version`, or `cursor` for null-version entities), never on an unchanged
// snapshot, never per render.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LiveEvent } from '@pc/contracts';

import { collectEvictions } from '../src/hooks/use-rich-link-invalidator.ts';

function ev(entityId: string | null, version: number | null, cursor: string): LiveEvent {
  return {
    id: `id-${entityId}-${cursor}`,
    cursor,
    scope: 'project',
    projectId: 'p1',
    type: 'work-item.changed',
    entity: 'work-item',
    entityId: entityId as never,
    version,
    createdAt: 1,
    payload: {},
  };
}

test('first sight of an entity evicts once and records its marker', () => {
  const { ids, next } = collectEvictions([ev('w1', 3, 'c1')], new Map());
  assert.deepEqual(ids, ['w1']);
  assert.equal(next.get('w1'), 3);
});

test('an unchanged snapshot (same marker) does NOT re-evict', () => {
  const seen = new Map<string, number | string>([['w1', 3]]);
  const { ids } = collectEvictions([ev('w1', 3, 'c1')], seen);
  assert.deepEqual(ids, []);
});

test('a newer version re-evicts and updates the recorded marker', () => {
  const seen = new Map<string, number | string>([['w1', 3]]);
  const { ids, next } = collectEvictions([ev('w1', 4, 'c2')], seen);
  assert.deepEqual(ids, ['w1']);
  assert.equal(next.get('w1'), 4);
});

test('null-version entities key on the cursor', () => {
  const first = collectEvictions([ev('a1', null, 'c1')], new Map());
  assert.deepEqual(first.ids, ['a1']);
  assert.equal(first.next.get('a1'), 'c1');
  // Same cursor → no re-evict.
  assert.deepEqual(collectEvictions([ev('a1', null, 'c1')], first.next).ids, []);
  // New cursor → re-evict.
  assert.deepEqual(collectEvictions([ev('a1', null, 'c2')], first.next).ids, ['a1']);
});

test('events with no entityId are skipped', () => {
  const { ids } = collectEvictions([ev(null, 1, 'c1')], new Map());
  assert.deepEqual(ids, []);
});

test('multiple entities each evict once on first sight', () => {
  const { ids } = collectEvictions([ev('w1', 1, 'c1'), ev('w2', 1, 'c2')], new Map());
  assert.deepEqual(ids.sort(), ['w1', 'w2']);
});
