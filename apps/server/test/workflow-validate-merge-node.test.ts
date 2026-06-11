// pc-pty-chat-270 Chunk A — validation of merge node at save time.
//
// A `merge` node requires `workflow.worktree !== 'none'`.
// `target` is a LEGACY field: absent is preferred; the literal 'dev' is
// accepted (stored defs + run snapshots carry it); anything else is rejected.
// Optional `on_conflict_stage` must be a non-empty string when set. Merge
// nodes do not produce output ($ref blocked).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowV2 } from '@pc/domain';
import { validateWorkflowV2 } from '@pc/workflows';

function wf(
  nodes: WorkflowV2.WorkflowNode[],
  extra: Partial<WorkflowV2.Workflow> = {},
): WorkflowV2.Workflow {
  return { id: 'wf', name: 'WF', nodes, ...extra };
}

const mergeNode: WorkflowV2.MergeNode = {
  id: 'merge-1',
  kind: 'merge',
  target: 'dev',
};

// ── worktree requirement ────────────────────────────────────────────────────

test('merge node in a worktree:none workflow is rejected', () => {
  const r = validateWorkflowV2(wf([mergeNode], { worktree: 'none' }));
  assert.equal(r.ok, false, 'merge in worktree:none must fail');
  assert.ok(
    r.errors.some((e) => /merge.*node.*worktree/i.test(e) || /worktree.*none/i.test(e)),
    `expected worktree-related error, got: ${r.errors.join('; ')}`,
  );
});

test('merge node in a worktree:auto workflow is valid', () => {
  const r = validateWorkflowV2(
    wf([mergeNode, { id: 'move-1', kind: 'move', stage: 'on-dev' }], { worktree: 'auto' }),
  );
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('merge node with no worktree field (defaults to auto) is valid', () => {
  const r = validateWorkflowV2(wf([mergeNode]));
  assert.equal(r.ok, true, r.errors.join('; '));
});

// ── target field (legacy) ────────────────────────────────────────────────────

test('merge node with a non-legacy target is rejected', () => {
  const bad = { ...mergeNode, target: 'main' as unknown as 'dev' };
  const r = validateWorkflowV2(wf([bad]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /target.*legacy/i.test(e)), r.errors.join('; '));
});

test('merge node with no target is valid (preferred authoring shape)', () => {
  const node = { id: 'merge-1', kind: 'merge' } as unknown as WorkflowV2.WorkflowNode;
  const r = validateWorkflowV2(wf([node]));
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('merge node with the legacy target "dev" is still valid (stored defs must not brick)', () => {
  const r = validateWorkflowV2(wf([mergeNode]));
  assert.equal(r.ok, true, r.errors.join('; '));
});

// ── on_conflict_stage ────────────────────────────────────────────────────────

test('merge node: on_conflict_stage as non-empty string is accepted', () => {
  const node: WorkflowV2.MergeNode = { ...mergeNode, on_conflict_stage: 'needs-merge' };
  const r = validateWorkflowV2(wf([node]));
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('merge node: on_conflict_stage as empty string is rejected', () => {
  const bad = { ...mergeNode, on_conflict_stage: '' };
  const r = validateWorkflowV2(wf([bad as unknown as WorkflowV2.WorkflowNode]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /on_conflict_stage/i.test(e)), r.errors.join('; '));
});

// ── merge nodes do not produce output ───────────────────────────────────────

test('reading $merge-node.output is rejected (merge steps produce no output)', () => {
  const r = validateWorkflowV2(
    wf([
      { ...mergeNode, next: ['a'] },
      {
        id: 'a',
        kind: 'agent',
        agent: 'x',
        task: 'use $merge-1.output',
        input: { result: '$merge-1.output' },
      },
    ]),
  );
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /merge-1.*merge step/i.test(e)),
    `expected merge-output error, got: ${r.errors.join('; ')}`,
  );
});
