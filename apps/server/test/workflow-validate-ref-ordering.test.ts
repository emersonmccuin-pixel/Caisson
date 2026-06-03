// Workflow-engine redesign (slice 6) — save-time validation: "Saved ⇒ runnable".
// §4.1 ref ordering — a step's `$X.output[.field]` must point at a strictly-
// earlier (upstream) step or the run-root card. A step can't read its own output
// or a downstream step's output that hasn't run yet.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowV2 } from '@pc/domain';
import { validateWorkflowV2, substituteInputs, extractInputPlaceholders } from '@pc/workflows';

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

test('substituteInputs / extractInputPlaceholders handle {{name}} placeholders', () => {
  assert.deepEqual(extractInputPlaceholders('a {{x}} and {{ y }} and {{x}}'), ['x', 'y', 'x']);
  assert.equal(
    substituteInputs('Expand {{outline}}; address {{feedback}}', {
      outline: '- a\n- b',
      feedback: 'be punchier',
    }),
    'Expand - a\n- b; address be punchier',
  );
  // unbound placeholder → '' (the validator rejects these at save).
  assert.equal(substituteInputs('hi {{missing}}', {}), 'hi ');
  // a resolved value containing `$` or `{{` is not re-mangled.
  assert.equal(substituteInputs('{{v}}', { v: '$x.output {{z}}' }), '$x.output {{z}}');
});

// ── declared input map ("a specific output port feeds the next node's input") ──

test('an input bound to an upstream output is valid; {{name}} resolves to it', () => {
  const r = validateWorkflowV2(
    wf([
      { id: 'a', kind: 'agent', agent: 'x', task: 'go', next: ['b'] },
      {
        id: 'b',
        kind: 'agent',
        agent: 'y',
        input: { outline: '$a.output' },
        task: 'expand {{outline}}',
      },
    ]),
  );
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('an input bound to a downstream output is rejected (ordering applies to input refs)', () => {
  const r = validateWorkflowV2(
    wf([
      { id: 'a', kind: 'agent', agent: 'x', input: { x: '$b.output' }, task: 'go {{x}}', next: ['b'] },
      { id: 'b', kind: 'agent', agent: 'y', task: 'go' },
    ]),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not an upstream step/.test(e)), r.errors.join('; '));
});

test('a {{name}} with no matching input key is rejected', () => {
  const r = validateWorkflowV2(
    wf([{ id: 'a', kind: 'agent', agent: 'x', task: 'use {{missing}}' }]),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /no matching input/.test(e)), r.errors.join('; '));
});

test('a literal input (no $ref) is fine and needs no upstream', () => {
  const r = validateWorkflowV2(
    wf([{ id: 'a', kind: 'agent', agent: 'x', input: { tone: 'punchy' }, task: 'write {{tone}}' }]),
  );
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('a malformed input map is rejected (non-identifier key / non-string value / not-an-object)', () => {
  const badKey = validateWorkflowV2(
    wf([{ id: 'a', kind: 'agent', agent: 'x', input: { '1bad': '$root.output' }, task: 'go' } as unknown as WorkflowV2.WorkflowNode]),
  );
  assert.ok(badKey.errors.some((e) => /must be a plain identifier/.test(e)), badKey.errors.join('; '));

  const badVal = validateWorkflowV2(
    wf([{ id: 'a', kind: 'agent', agent: 'x', input: { k: 5 }, task: 'go' } as unknown as WorkflowV2.WorkflowNode]),
  );
  assert.ok(badVal.errors.some((e) => /must be a string ref or literal/.test(e)), badVal.errors.join('; '));

  const notObj = validateWorkflowV2(
    wf([{ id: 'a', kind: 'agent', agent: 'x', input: ['$root.output'], task: 'go' } as unknown as WorkflowV2.WorkflowNode]),
  );
  assert.ok(notObj.errors.some((e) => /input must be a map/.test(e)), notObj.errors.join('; '));
});

// Unified review step (slice 5): one `review` kind, `reviewer` picks the inbox.
test('a review node requires a valid reviewer', () => {
  const ok = validateWorkflowV2(
    wf([
      { id: 'a', kind: 'agent', agent: 'x', task: 'go', next: ['r'] },
      { id: 'r', kind: 'review', reviewer: 'orchestrator', prompt: 'ok?' },
    ]),
  );
  assert.equal(ok.ok, true, ok.errors.join('; '));

  const bad = validateWorkflowV2(
    wf([{ id: 'r', kind: 'review', prompt: 'ok?' } as unknown as WorkflowV2.WorkflowNode]),
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /reviewer must be/.test(e)), bad.errors.join('; '));
});
