// pc-pty-chat-355 — Unit tests for buildFocusTree grouping logic.
// Pure node:test; no jsdom required.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFocusTree, type FocusItem } from '../src/components/work-items/focus-group.ts';

function item(
  over: Partial<FocusItem> & Pick<FocusItem, 'id' | 'projectId'>,
): FocusItem {
  return {
    areaId: null,
    title: 'Task',
    callsign: null,
    status: 'pending',
    focusedAt: 1000,
    ...over,
  };
}

const proj1 = { id: 'p1', name: 'Alpha' };
const proj2 = { id: 'p2', name: 'Beta' };
const area1 = { id: 'a1', projectId: 'p1', name: 'Frontend' };
const area2 = { id: 'a2', projectId: 'p1', name: 'Backend' };

test('empty items → empty tree', () => {
  const tree = buildFocusTree([], [proj1], [area1]);
  assert.deepEqual(tree, []);
});

test('items with no areas go under Uncategorized', () => {
  const tree = buildFocusTree(
    [item({ id: 'w1', projectId: 'p1', title: 'Fix it' })],
    [proj1],
    [],
  );
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'Alpha');
  assert.equal(tree[0].areas.length, 1);
  assert.equal(tree[0].areas[0].id, null);
  assert.equal(tree[0].areas[0].name, 'Uncategorized');
  assert.equal(tree[0].areas[0].items[0].title, 'Fix it');
});

test('items nest under their real area, alphabetically', () => {
  const tree = buildFocusTree(
    [
      item({ id: 'w1', projectId: 'p1', areaId: 'a2', title: 'Server' }),
      item({ id: 'w2', projectId: 'p1', areaId: 'a1', title: 'UI' }),
    ],
    [proj1],
    [area1, area2],
  );
  assert.equal(tree.length, 1);
  assert.equal(tree[0].areas.length, 2);
  // Backend (a2) sorts before Frontend (a1) alphabetically.
  assert.equal(tree[0].areas[0].name, 'Backend');
  assert.equal(tree[0].areas[1].name, 'Frontend');
});

test('Uncategorized always last when named areas present', () => {
  const tree = buildFocusTree(
    [
      item({ id: 'w1', projectId: 'p1', areaId: 'a1', title: 'UI' }),
      item({ id: 'w2', projectId: 'p1', areaId: null, title: 'Loose' }),
    ],
    [proj1],
    [area1],
  );
  const areas = tree[0].areas;
  assert.equal(areas[areas.length - 1].id, null);
  assert.equal(areas[areas.length - 1].name, 'Uncategorized');
});

test('items from multiple projects get separate project rows, sorted by name', () => {
  const tree = buildFocusTree(
    [
      item({ id: 'w1', projectId: 'p2', title: 'B item' }),
      item({ id: 'w2', projectId: 'p1', title: 'A item' }),
    ],
    [proj1, proj2],
    [],
  );
  assert.equal(tree.length, 2);
  assert.equal(tree[0].name, 'Alpha');
  assert.equal(tree[1].name, 'Beta');
});

test('focused item shown under its real project even if project has no focusedAt', () => {
  // Projects never carry focusedAt in the focus-group logic; the tree builds
  // from the item's projectId only.
  const tree = buildFocusTree(
    [item({ id: 'w1', projectId: 'p1', title: 'Task' })],
    [proj1],
    [],
  );
  assert.equal(tree[0].id, 'p1');
  assert.equal(tree[0].areas[0].items[0].id, 'w1');
});

test('unknown area id falls back to id as name', () => {
  const tree = buildFocusTree(
    [item({ id: 'w1', projectId: 'p1', areaId: 'unknown-area' })],
    [proj1],
    [], // no area map entry
  );
  assert.equal(tree[0].areas[0].name, 'unknown-area');
});

test('unknown project id falls back to id as name', () => {
  const tree = buildFocusTree(
    [item({ id: 'w1', projectId: 'p-missing' })],
    [], // no project map entry
    [],
  );
  assert.equal(tree[0].name, 'p-missing');
});
