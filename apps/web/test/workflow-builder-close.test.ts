// T3.2b — WorkflowBuilderModal close decision (`shouldCloseWorkflowBuilder`).
// Skip deleted; edit mode → close only when slug matches + change in
// {updated,created}; new mode → close on created.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldCloseWorkflowBuilder } from '../src/features/workflows/live-events.ts';

test('new mode: close on created, ignore updated/deleted', () => {
  assert.equal(shouldCloseWorkflowBuilder({ change: 'created', definition: { slug: 'a' } }, null), true);
  assert.equal(shouldCloseWorkflowBuilder({ change: 'updated', definition: { slug: 'a' } }, null), false);
  assert.equal(shouldCloseWorkflowBuilder({ change: 'deleted', definition: { slug: 'a' } }, null), false);
});

test('edit mode: close on updated/created of the edited slug', () => {
  assert.equal(shouldCloseWorkflowBuilder({ change: 'updated', definition: { slug: 'mine' } }, 'mine'), true);
  assert.equal(shouldCloseWorkflowBuilder({ change: 'created', definition: { slug: 'mine' } }, 'mine'), true);
});

test('edit mode: a different slug does NOT close', () => {
  assert.equal(shouldCloseWorkflowBuilder({ change: 'updated', definition: { slug: 'other' } }, 'mine'), false);
});

test('edit mode: deleted never closes', () => {
  assert.equal(shouldCloseWorkflowBuilder({ change: 'deleted', definition: { slug: 'mine' } }, 'mine'), false);
});

test('edit mode: a frame without a slug still closes on updated (defensive)', () => {
  assert.equal(shouldCloseWorkflowBuilder({ change: 'updated' }, 'mine'), true);
});
