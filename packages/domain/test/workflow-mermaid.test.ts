// Unit tests for workflowToMermaid.
// Verifies deterministic output for every node kind, edge kinds, and structure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { workflowToMermaid } from '../src/workflow-mermaid.ts';
import type { WorkflowV2 } from '../src/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentNode(id: string, next?: string[]): WorkflowV2.AgentNode {
  return { id, kind: 'agent', agent: 'orchestrator', task: 'do work', next };
}

function reviewNode(
  id: string,
  opts: { reviewer?: WorkflowV2.Reviewer; next?: string[]; reject?: string } = {},
): WorkflowV2.ReviewNode {
  return {
    id,
    kind: 'review',
    reviewer: opts.reviewer ?? 'human',
    next: opts.next,
    reject: opts.reject,
  };
}

function moveNode(id: string, stage: string, next?: string[]): WorkflowV2.MoveNode {
  return { id, kind: 'move', stage, next };
}

function loopNode(id: string, back_to: string, max?: number | null): WorkflowV2.LoopNode {
  return { id, kind: 'loop', back_to, max_iterations: max };
}

function mergeNode(id: string, next?: string[]): WorkflowV2.MergeNode {
  return { id, kind: 'merge', target: 'dev', next };
}

function makeWf(nodes: WorkflowV2.WorkflowNode[]): WorkflowV2.Workflow {
  return { id: 'test', name: 'Test', nodes };
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test('workflowToMermaid: starts with flowchart LR', () => {
  const result = workflowToMermaid(makeWf([]));
  assert.ok(result.startsWith('flowchart LR'));
});

test('workflowToMermaid: includes all five classDef entries', () => {
  const result = workflowToMermaid(makeWf([]));
  assert.ok(result.includes('agentNode'));
  assert.ok(result.includes('reviewNode'));
  assert.ok(result.includes('moveNode'));
  assert.ok(result.includes('loopNode'));
  assert.ok(result.includes('mergeNode'));
});

// ---------------------------------------------------------------------------
// Node kinds -- shape syntax
// ---------------------------------------------------------------------------

test('workflowToMermaid: agent node uses stadium shape and agentNode class', () => {
  const result = workflowToMermaid(makeWf([agentNode('write-code')]));
  assert.ok(result.includes('n_write_code(["'));
  assert.ok(result.includes('class n_write_code agentNode'));
});

test('workflowToMermaid: review node uses diamond shape and reviewNode class', () => {
  const result = workflowToMermaid(makeWf([reviewNode('human-check')]));
  assert.ok(result.includes('n_human_check{"'));
  assert.ok(result.includes('class n_human_check reviewNode'));
});

test('workflowToMermaid: move node uses parallelogram shape and moveNode class', () => {
  const result = workflowToMermaid(makeWf([moveNode('promote-card', 'in-review')]));
  assert.ok(result.includes('n_promote_card[/"'));
  assert.ok(result.includes('class n_promote_card moveNode'));
});

test('workflowToMermaid: loop node uses circle shape and loopNode class', () => {
  const result = workflowToMermaid(makeWf([loopNode('retry-loop', 'write-code', 3)]));
  // Circle shape: (("..."))
  assert.ok(result.includes('n_retry_loop(("'));
  assert.ok(result.includes('class n_retry_loop loopNode'));
});

test('workflowToMermaid: merge node uses hexagon shape and mergeNode class', () => {
  const result = workflowToMermaid(makeWf([mergeNode('merge-dev')]));
  assert.ok(result.includes('n_merge_dev{{"'));
  assert.ok(result.includes('class n_merge_dev mergeNode'));
});

// ---------------------------------------------------------------------------
// Edge kinds
// ---------------------------------------------------------------------------

test('workflowToMermaid: forward edge from agent node is solid arrow', () => {
  const result = workflowToMermaid(makeWf([agentNode('a', ['b']), agentNode('b')]));
  assert.ok(result.includes('n_a --> n_b'));
});

test('workflowToMermaid: review approve-path is labeled approve', () => {
  const result = workflowToMermaid(
    makeWf([reviewNode('check', { next: ['done'] }), moveNode('done', 'completed')]),
  );
  assert.ok(result.includes('n_check -->|approve| n_done'));
});

test('workflowToMermaid: reject edge is dashed and labeled reject', () => {
  const result = workflowToMermaid(
    makeWf([reviewNode('check', { reject: 'retry' }), loopNode('retry', 'check')]),
  );
  assert.ok(result.includes('n_check -.->|reject| n_retry'));
});

test('workflowToMermaid: loop back-edge is dashed and labeled retry', () => {
  const result = workflowToMermaid(
    makeWf([
      agentNode('write', ['check']),
      reviewNode('check', { next: ['done'], reject: 'retry' }),
      loopNode('retry', 'write'),
      moveNode('done', 'completed'),
    ]),
  );
  assert.ok(result.includes('n_retry -.->|retry| n_write'));
});

// ---------------------------------------------------------------------------
// Full reject-loop workflow
// ---------------------------------------------------------------------------

test('workflowToMermaid: full reject-loop workflow emits correct edges', () => {
  const nodes: WorkflowV2.WorkflowNode[] = [
    agentNode('write', ['review']),
    reviewNode('review', { reviewer: 'human', next: ['done'], reject: 'retry-loop' }),
    loopNode('retry-loop', 'write', 3),
    moveNode('done', 'completed'),
  ];
  const result = workflowToMermaid(makeWf(nodes));
  assert.ok(result.includes('n_write --> n_review'));
  assert.ok(result.includes('n_review -->|approve| n_done'));
  assert.ok(result.includes('n_review -.->|reject| n_retry_loop'));
  assert.ok(result.includes('n_retry_loop -.->|retry| n_write'));
});

// ---------------------------------------------------------------------------
// Review labels
// ---------------------------------------------------------------------------

test('workflowToMermaid: human reviewer label contains Approve', () => {
  const result = workflowToMermaid(makeWf([reviewNode('gate', { reviewer: 'human' })]));
  assert.ok(result.includes('Approve'));
});

test('workflowToMermaid: orchestrator reviewer label contains Auto-review', () => {
  const result = workflowToMermaid(makeWf([reviewNode('gate', { reviewer: 'orchestrator' })]));
  assert.ok(result.includes('Auto-review'));
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('workflowToMermaid: deterministic -- same definition produces same output', () => {
  const nodes: WorkflowV2.WorkflowNode[] = [
    agentNode('a', ['b']),
    reviewNode('b', { next: ['c'], reject: 'rl' }),
    loopNode('rl', 'a'),
    mergeNode('c'),
  ];
  const wf = makeWf(nodes);
  assert.strictEqual(workflowToMermaid(wf), workflowToMermaid(wf));
});

// ---------------------------------------------------------------------------
// ID sanitization
// ---------------------------------------------------------------------------

test('workflowToMermaid: hyphens in node ids become underscores', () => {
  const result = workflowToMermaid(makeWf([agentNode('write-the-code')]));
  assert.ok(result.includes('n_write_the_code'));
  assert.ok(!result.includes('write-the-code(['));
});

// ---------------------------------------------------------------------------
// Loop max_iterations variants
// ---------------------------------------------------------------------------

test('workflowToMermaid: loop with null max_iterations shows unlimited', () => {
  const result = workflowToMermaid(makeWf([loopNode('rl', 'back', null)]));
  assert.ok(result.includes('unlimited'));
});

test('workflowToMermaid: loop with numeric max shows max N', () => {
  const result = workflowToMermaid(makeWf([loopNode('rl', 'back', 5)]));
  assert.ok(result.includes('max 5'));
});
