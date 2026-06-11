// M6 slice C — restart-at-step pure helpers (FD-11 req 2+3): the compat check
// that gates re-freezing an edited definition onto a failed run, and the state
// reset that keeps completed work while re-running failed/skipped/ghost steps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowV2 } from '@pc/domain';
import { resumeCompatErrors, resetFailedNodesForResume } from '@pc/workflows';

const WF: WorkflowV2.Workflow = {
  id: 'wf',
  name: 'WF',
  nodes: [
    { id: 'a', kind: 'agent', agent: 'x', task: 'go', next: ['b'] },
    { id: 'b', kind: 'agent', agent: 'y', task: 'go', next: ['gate'] },
    { id: 'gate', kind: 'review', reviewer: 'human', reject: 'gate-loop' },
    { id: 'gate-loop', kind: 'loop', back_to: 'b' },
  ],
};

test('compat: an edit that removes a settled node is refused by name', () => {
  const state: WorkflowV2.WorkflowDagState = {
    nodes: { a: { state: 'completed' }, b: { state: 'failed' } },
  };
  const edited: WorkflowV2.Workflow = {
    ...WF,
    nodes: WF.nodes.filter((n) => n.id !== 'a'),
  };
  const errors = resumeCompatErrors(edited, state);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /"a"/);

  // The unedited def (or one that only ADDS nodes) is compatible.
  assert.deepEqual(resumeCompatErrors(WF, state), []);
});

test('compat: an edit that changes a settled node KIND is refused (snapshot supplied)', () => {
  const state: WorkflowV2.WorkflowDagState = {
    nodes: { a: { state: 'completed' }, b: { state: 'failed' } },
  };
  const edited: WorkflowV2.Workflow = {
    ...WF,
    nodes: WF.nodes.map((n) =>
      n.id === 'a' ? ({ id: 'a', kind: 'move', stage: 'st-1', next: ['b'] } as WorkflowV2.MoveNode) : n,
    ),
  };
  const errors = resumeCompatErrors(edited, state, WF);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /"a".*kind "agent" → "move"/);

  // A kind change on a node that never ran is fine.
  const editedPending: WorkflowV2.Workflow = {
    ...WF,
    nodes: WF.nodes.map((n) =>
      n.id === 'b' ? ({ id: 'b', kind: 'move', stage: 'st-1', next: ['gate'] } as WorkflowV2.MoveNode) : n,
    ),
  };
  const pendingState: WorkflowV2.WorkflowDagState = {
    nodes: { a: { state: 'completed' }, b: { state: 'pending' } },
  };
  assert.deepEqual(resumeCompatErrors(editedPending, pendingState, WF), []);

  // Without the snapshot the existence check still runs (back-compat).
  assert.deepEqual(resumeCompatErrors(edited, state), []);
});

test('reset: failed/skipped/ghost nodes → pending; completed + loop bookkeeping kept', () => {
  const state: WorkflowV2.WorkflowDagState = {
    nodes: {
      a: { state: 'completed', workItemId: 'wi-a' },
      b: { state: 'failed', error: 'boom', iteration: 2 },
      gate: { state: 'skipped' },
      'gate-loop': { state: 'pending', iteration: 1 },
    },
    rejectIterations: { 'gate-loop': 1 },
    rejectFeedback: { gate: 'tighter please' },
  };
  const { state: next, resetNodes } = resetFailedNodesForResume(WF, state);
  assert.deepEqual(resetNodes.sort(), ['b', 'gate']);
  assert.equal(next.nodes['a']!.state, 'completed', 'completed work is KEPT');
  assert.equal(next.nodes['b']!.state, 'pending');
  assert.equal(next.nodes['b']!.iteration, 2, 'iteration history survives the reset');
  assert.equal(next.nodes['gate']!.state, 'pending');
  assert.deepEqual(next.rejectIterations, { 'gate-loop': 1 }, 'loop ceiling bookkeeping kept');
  assert.deepEqual(next.rejectFeedback, { gate: 'tighter please' });

  // A node ADDED by the repair edit starts pending.
  const grown: WorkflowV2.Workflow = {
    ...WF,
    nodes: [...WF.nodes, { id: 'new-step', kind: 'agent', agent: 'z', task: 'extra' }],
  };
  const { state: next2 } = resetFailedNodesForResume(grown, state);
  assert.equal(next2.nodes['new-step']!.state, 'pending');
});
