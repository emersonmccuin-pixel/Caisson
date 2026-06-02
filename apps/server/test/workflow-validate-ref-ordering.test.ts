// Workflow-engine redesign (slice 6) — save-time validation: "Saved ⇒ runnable".
// §4.1 ref ordering — a step's `$X.output[.field]` must point at a strictly-
// earlier (upstream) step or the run-root card. A step can't read its own output
// or a downstream step's output that hasn't run yet.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowV2 } from '@pc/domain';
import { validateWorkflowV2 } from '@pc/workflows';

function wf(nodes: WorkflowV2.WorkflowNode[]): WorkflowV2.Workflow {
  return { id: 'wf', name: 'WF', triggers: [{ kind: 'manual' }], nodes };
}

test('a ref to an upstream step is valid', () => {
  const r = validateWorkflowV2(
    wf([
      { id: 'a', kind: 'agent', agent: 'x', task: 'go', next: ['b'] },
      { id: 'b', kind: 'agent', agent: 'y', task: 'use $a.output.key' },
    ]),
  );
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('a ref to a downstream step is rejected', () => {
  const r = validateWorkflowV2(
    wf([
      { id: 'a', kind: 'agent', agent: 'x', task: 'use $b.output', next: ['b'] },
      { id: 'b', kind: 'agent', agent: 'y', task: 'go' },
    ]),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not an upstream step/.test(e)), r.errors.join('; '));
});

test('a ref to the step itself is rejected', () => {
  const r = validateWorkflowV2(
    wf([{ id: 'a', kind: 'agent', agent: 'x', task: 'use $a.output' }]),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /its own output/.test(e)), r.errors.join('; '));
});

test('a $root ref is always valid', () => {
  const r = validateWorkflowV2(
    wf([{ id: 'a', kind: 'agent', agent: 'x', task: 'use $root.output.epic' }]),
  );
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('a ref to an unknown node is rejected', () => {
  const r = validateWorkflowV2(
    wf([{ id: 'a', kind: 'agent', agent: 'x', task: 'use $ghost.output' }]),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /no such node/.test(e)), r.errors.join('; '));
});
