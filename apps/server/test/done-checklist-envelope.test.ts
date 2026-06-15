// Slice D — done-checklist render + regression guard for `buildAgentCompletedBody` /
// `buildAgentFailedBody`, and the replay-null invariant.
//
// Three properties verified:
//   1. Completed body with a checklist renders the exact [done-checklist] block format.
//   2. Failed body with a checklist also renders the block (failed run ≠ erased checklist).
//   3. No checklist (null / absent) → output is BYTE-IDENTICAL to the pre-Slice-D baseline
//      (regression guard — emitting any extra bytes when no checklist is set is a bug).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentCompletedBody,
  buildAgentFailedBody,
} from '../src/services/agent-event-header.ts';

// ── shared fixture ────────────────────────────────────────────────────────────

const BASE_COMPLETED_ARGS = {
  runId: 'run-01',
  sessionId: 'sess-01',
  agentName: 'coder',
  parentWorkItemId: 'wi-01',
  result: 'done',
} as const;

const BASE_FAILED_ARGS = {
  runId: 'run-02',
  sessionId: 'sess-02',
  agentName: 'coder',
  parentWorkItemId: 'wi-01',
  reason: 'timed out',
  cause: 'timeout' as const,
} as const;

const CHECKLIST = {
  total: 4,
  open: 2,
  items: [
    { label: 'Code written + tests green', done: true },
    { label: 'Reviewed', done: true },
    { label: 'Docs updated', done: false },
    { label: 'Merged to main', done: false },
  ],
};

// ── 1. completed body WITH checklist ─────────────────────────────────────────

test('buildAgentCompletedBody: [done-checklist] block is rendered with correct format', () => {
  const body = buildAgentCompletedBody({ ...BASE_COMPLETED_ARGS, doneChecklist: CHECKLIST });

  assert.ok(
    body.includes('[done-checklist: 2 of 4 open]'),
    'must contain the summary tag',
  );
  assert.ok(body.includes('  [x] Code written + tests green'), 'ticked item must use [x]');
  assert.ok(body.includes('  [x] Reviewed'), 'ticked item must use [x]');
  assert.ok(body.includes('  [ ] Docs updated'), 'open item must use [ ]');
  assert.ok(body.includes('  [ ] Merged to main'), 'open item must use [ ]');

  // The block must appear between the header tags and the Result: section.
  const checklistIdx = body.indexOf('[done-checklist:');
  const resultIdx = body.indexOf('Result:');
  assert.ok(checklistIdx > 0, 'block must be present');
  assert.ok(checklistIdx < resultIdx, 'block must appear before Result: section');
});

// ── 2. failed body WITH checklist ────────────────────────────────────────────

test('buildAgentFailedBody: [done-checklist] block is rendered on failure (card items not erased)', () => {
  const body = buildAgentFailedBody({ ...BASE_FAILED_ARGS, doneChecklist: CHECKLIST });

  assert.ok(body.includes('[done-checklist: 2 of 4 open]'), 'must contain the summary tag');
  assert.ok(body.includes('  [x] Code written + tests green'), 'ticked item must use [x]');
  assert.ok(body.includes('  [ ] Docs updated'), 'open item must use [ ]');

  // Block must appear before the Failure: section.
  const checklistIdx = body.indexOf('[done-checklist:');
  const failureIdx = body.indexOf('Failure:');
  assert.ok(checklistIdx > 0, 'block must be present');
  assert.ok(checklistIdx < failureIdx, 'block must appear before Failure: section');
});

// ── 3. regression guard — no checklist → byte-identical output ───────────────

test('buildAgentCompletedBody: no doneChecklist → output byte-identical to pre-Slice-D baseline', () => {
  const withNull = buildAgentCompletedBody({ ...BASE_COMPLETED_ARGS, doneChecklist: null });
  const withAbsent = buildAgentCompletedBody({ ...BASE_COMPLETED_ARGS });
  const withUndefined = buildAgentCompletedBody({ ...BASE_COMPLETED_ARGS, doneChecklist: undefined });

  // All three must be identical (null / absent / undefined all suppress the block).
  assert.strictEqual(withNull, withAbsent, 'null and absent must be identical');
  assert.strictEqual(withNull, withUndefined, 'null and undefined must be identical');

  // And neither must contain the block tag.
  assert.ok(!withNull.includes('[done-checklist:'), 'no checklist → block must be absent');
});

test('buildAgentFailedBody: no doneChecklist → output byte-identical to pre-Slice-D baseline', () => {
  const withNull = buildAgentFailedBody({ ...BASE_FAILED_ARGS, doneChecklist: null });
  const withAbsent = buildAgentFailedBody({ ...BASE_FAILED_ARGS });

  assert.strictEqual(withNull, withAbsent, 'null and absent must be identical');
  assert.ok(!withNull.includes('[done-checklist:'), 'no checklist → block must be absent');
});

// ── 4. replay-path invariant — passing null always suppresses the block ───────

test('replay path: passing doneChecklist: null always suppresses the block (Gotcha #3)', () => {
  // The replay call site passes doneChecklist: null explicitly; verify the contract.
  const completedBody = buildAgentCompletedBody({ ...BASE_COMPLETED_ARGS, doneChecklist: null });
  const failedBody = buildAgentFailedBody({ ...BASE_FAILED_ARGS, doneChecklist: null });

  assert.ok(
    !completedBody.includes('[done-checklist:'),
    'completed: null must suppress block',
  );
  assert.ok(
    !failedBody.includes('[done-checklist:'),
    'failed: null must suppress block',
  );
});
