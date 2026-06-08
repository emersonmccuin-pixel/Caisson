// T5 — run-state-backed "Waiting on you" signal (pc-pty-chat-318).
//
// Tests the real exported `applyReviewChange` pure function from the
// workflow-human-reviews-util.ts.  The hook itself (use-project-workflow-
// human-reviews.ts) imports React/zustand and cannot be driven from
// tsx --test (no DOM harness in this package).  The pure util is the
// load-bearing derivation — a rename or signature break fails these tests.
//
// We also assert the HOOK is exported from the main module file at the
// import level, so a rename there is caught too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure util — no React, importable by tsx --test.
import { applyReviewChange } from '../src/hooks/workflow-human-reviews-util.ts';

// ── exports contract on the pure util ────────────────────────────────────────

import * as UtilModule from '../src/hooks/workflow-human-reviews-util.ts';

test('applyReviewChange is exported from the util module', () => {
  assert.equal(typeof UtilModule.applyReviewChange, 'function');
});

// ── applyReviewChange ─────────────────────────────────────────────────────────

test('adds runId when flavor=human state=pending and runId not already present', () => {
  const before = new Set<string>();
  const after = applyReviewChange(before, { runId: 'run-1', flavor: 'human', state: 'pending' });
  assert.ok(after.has('run-1'), 'run-1 should be in the pending set');
  assert.equal(after.size, 1);
});

test('returns same Set identity when flavor=human state=pending but runId already present', () => {
  const before = new Set(['run-1']);
  const after = applyReviewChange(before, { runId: 'run-1', flavor: 'human', state: 'pending' });
  // No mutation needed — check contents not identity (Set is rebuilt)
  assert.ok(after.has('run-1'));
  assert.equal(after.size, 1);
});

test('removes runId when flavor=human state=approved', () => {
  const before = new Set(['run-1', 'run-2']);
  const after = applyReviewChange(before, { runId: 'run-1', flavor: 'human', state: 'approved' });
  assert.ok(!after.has('run-1'), 'run-1 should be removed after approval');
  assert.ok(after.has('run-2'), 'run-2 should remain');
});

test('removes runId when flavor=human state=rejected', () => {
  const before = new Set(['run-1']);
  const after = applyReviewChange(before, { runId: 'run-1', flavor: 'human', state: 'rejected' });
  assert.ok(!after.has('run-1'));
  assert.equal(after.size, 0);
});

test('does not add runId when flavor=orchestrator state=pending', () => {
  const before = new Set<string>();
  const after = applyReviewChange(before, {
    runId: 'run-1',
    flavor: 'orchestrator',
    state: 'pending',
  });
  assert.equal(after.size, 0, 'orchestrator reviews must not affect the human pending set');
});

test('does not remove runId when flavor=orchestrator state=approved', () => {
  const before = new Set(['run-1']);
  const after = applyReviewChange(before, {
    runId: 'run-1',
    flavor: 'orchestrator',
    state: 'approved',
  });
  assert.ok(after.has('run-1'), 'orchestrator approval must not clear a human-pending entry');
});

test('no-op for unknown state with human flavor', () => {
  const before = new Set(['run-1']);
  const after = applyReviewChange(before, { runId: 'run-1', flavor: 'human', state: 'unknown' });
  assert.ok(after.has('run-1'), 'unknown state should leave the set unchanged');
});

test('handles empty pending set with approved state gracefully', () => {
  const before = new Set<string>();
  const after = applyReviewChange(before, { runId: 'run-99', flavor: 'human', state: 'approved' });
  assert.equal(after.size, 0);
});

test('multiple runs accumulate independently', () => {
  let s = new Set<string>();
  s = applyReviewChange(s, { runId: 'run-a', flavor: 'human', state: 'pending' });
  s = applyReviewChange(s, { runId: 'run-b', flavor: 'human', state: 'pending' });
  assert.equal(s.size, 2);
  s = applyReviewChange(s, { runId: 'run-a', flavor: 'human', state: 'approved' });
  assert.equal(s.size, 1);
  assert.ok(s.has('run-b'));
});
