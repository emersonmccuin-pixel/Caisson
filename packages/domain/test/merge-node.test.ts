// pc-pty-chat-270 Chunk A — MergeNode domain type tests.
//
// Verifies that `isMergeNode` guard works, that a MergeNode round-trips through
// JSON without loss, and that the guard returns false for other node kinds.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowV2 } from '../src/index.ts';
import { isMergeNode, isReviewNode, isMoveNode, isLoopNode, WORKFLOW_NODE_KINDS } from '../src/workflow-v2.ts';

test('WORKFLOW_NODE_KINDS includes "merge"', () => {
  assert.ok(
    (WORKFLOW_NODE_KINDS as readonly string[]).includes('merge'),
    'merge must be in WORKFLOW_NODE_KINDS',
  );
});

test('isMergeNode: returns true for a merge node', () => {
  const node: WorkflowV2.MergeNode = {
    id: 'merge-1',
    kind: 'merge',
    target: 'dev',
  };
  assert.equal(isMergeNode(node), true);
});

test('isMergeNode: returns false for other node kinds', () => {
  const agent: WorkflowV2.AgentNode = { id: 'a', kind: 'agent', agent: 'x', task: 'go' };
  const review: WorkflowV2.ReviewNode = { id: 'r', kind: 'review', reviewer: 'human' };
  const move: WorkflowV2.MoveNode = { id: 'm', kind: 'move', stage: 'done' };
  const loop: WorkflowV2.LoopNode = { id: 'l', kind: 'loop', back_to: 'a' };
  assert.equal(isMergeNode(agent), false);
  assert.equal(isMergeNode(review), false);
  assert.equal(isMergeNode(move), false);
  assert.equal(isMergeNode(loop), false);
});

test('isMergeNode: other guards are still false for a merge node', () => {
  const node: WorkflowV2.MergeNode = { id: 'merge-1', kind: 'merge', target: 'dev' };
  assert.equal(isReviewNode(node as WorkflowV2.WorkflowNode), false);
  assert.equal(isMoveNode(node as WorkflowV2.WorkflowNode), false);
  assert.equal(isLoopNode(node as WorkflowV2.WorkflowNode), false);
});

test('MergeNode round-trips through JSON', () => {
  const node: WorkflowV2.MergeNode = {
    id: 'merge-2',
    kind: 'merge',
    target: 'dev',
    conflict_reviewer: 'orchestrator',
    on_conflict_stage: 'needs-merge',
    next: ['move-to-on-dev'],
  };
  const parsed = JSON.parse(JSON.stringify(node)) as WorkflowV2.MergeNode;
  assert.equal(parsed.kind, 'merge');
  assert.equal(parsed.target, 'dev');
  assert.equal(parsed.conflict_reviewer, 'orchestrator');
  assert.equal(parsed.on_conflict_stage, 'needs-merge');
  assert.deepEqual(parsed.next, ['move-to-on-dev']);
  assert.equal(isMergeNode(parsed as WorkflowV2.WorkflowNode), true);
});

test('MergeNode: optional fields are truly optional (minimal shape)', () => {
  const node: WorkflowV2.MergeNode = { id: 'merge-3', kind: 'merge', target: 'dev' };
  assert.equal(node.conflict_reviewer, undefined);
  assert.equal(node.on_conflict_stage, undefined);
  assert.equal(node.next, undefined);
  assert.equal(isMergeNode(node), true);
});

test('MergeNode: target itself is optional (legacy token, engine never reads it)', () => {
  const node: WorkflowV2.MergeNode = { id: 'merge-4', kind: 'merge' };
  assert.equal(node.target, undefined);
  assert.equal(isMergeNode(node), true);
});
