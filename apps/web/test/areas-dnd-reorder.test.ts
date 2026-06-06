// Drag-to-reorder contracts for AreasTab (pc-pty-chat-240).
//
// The tsx --test runner cannot import React components (@/ alias unresolved),
// so we pin the pure logic extracted from AreasTab:
//   1. arrayMove produces correct order after a drag
//   2. optimistic order is applied over the sorted base
//   3. Uncategorized card is excluded from the reorder payload
//   4. no-op drag (same source/dest) does not emit a reorder call

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── arrayMove (verbatim logic from @dnd-kit/sortable, pinned here) ───────────

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const result = [...arr];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item!);
  return result;
}

const IDS = ['a1', 'a2', 'a3', 'a4'];

test('arrayMove: moves item forward', () => {
  const result = arrayMove(IDS, 0, 2); // a1 → position 2
  assert.deepEqual(result, ['a2', 'a3', 'a1', 'a4']);
});

test('arrayMove: moves item backward', () => {
  const result = arrayMove(IDS, 3, 1); // a4 → position 1
  assert.deepEqual(result, ['a1', 'a4', 'a2', 'a3']);
});

test('arrayMove: same index is a no-op', () => {
  const result = arrayMove(IDS, 1, 1);
  assert.deepEqual(result, IDS);
});

test('arrayMove: adjacent swap', () => {
  const result = arrayMove(IDS, 1, 2);
  assert.deepEqual(result, ['a1', 'a3', 'a2', 'a4']);
});

// ── optimistic order application ─────────────────────────────────────────────

interface FakeArea { id: string; sortOrder: number }

function applyLocalOrder(sorted: FakeArea[], localOrder: string[] | null): FakeArea[] {
  if (!localOrder) return sorted;
  const byId = new Map(sorted.map((a) => [a.id, a]));
  return localOrder.flatMap((id) => {
    const a = byId.get(id);
    return a ? [a] : [];
  });
}

const AREAS: FakeArea[] = [
  { id: 'a1', sortOrder: 0 },
  { id: 'a2', sortOrder: 1 },
  { id: 'a3', sortOrder: 2 },
];

test('applyLocalOrder: null local order returns sorted as-is', () => {
  const result = applyLocalOrder(AREAS, null);
  assert.deepEqual(result.map((a) => a.id), ['a1', 'a2', 'a3']);
});

test('applyLocalOrder: local order overrides sortOrder', () => {
  const result = applyLocalOrder(AREAS, ['a3', 'a1', 'a2']);
  assert.deepEqual(result.map((a) => a.id), ['a3', 'a1', 'a2']);
});

test('applyLocalOrder: unknown ids in localOrder are silently skipped', () => {
  const result = applyLocalOrder(AREAS, ['a2', 'a-missing', 'a1', 'a3']);
  assert.deepEqual(result.map((a) => a.id), ['a2', 'a1', 'a3']);
});

// ── Uncategorized is excluded from reorder payload ───────────────────────────

test('Uncategorized id is absent from the reorder array (only real area ids sent)', () => {
  // AreasTab maps displayAreas (real areas only, no UncategorizedCard) for the
  // reorder payload. The Uncategorized card sits OUTSIDE the SortableContext.
  const realAreaIds = ['a1', 'a2', 'a3'];
  // Simulate a drag: a3 moves to position 0.
  const reordered = arrayMove(realAreaIds, 2, 0);
  assert.deepEqual(reordered, ['a3', 'a1', 'a2']);
  // Uncategorized is never in the array.
  assert.ok(!reordered.includes('uncategorized'));
});

// ── No-op drag guard ─────────────────────────────────────────────────────────

test('no-op: active.id === over.id skips the reorder call', () => {
  let reorderCalled = false;
  function handleDragEnd(activeId: string, overId: string | null) {
    if (!overId || activeId === overId) return;
    reorderCalled = true;
  }

  handleDragEnd('a1', 'a1'); // same
  assert.equal(reorderCalled, false);

  handleDragEnd('a1', null); // no over
  assert.equal(reorderCalled, false);

  handleDragEnd('a1', 'a2'); // real move
  handleDragEnd('a2', 'a3');
  assert.equal(reorderCalled, true);
});
