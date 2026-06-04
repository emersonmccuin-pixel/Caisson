// M6 — migrateWorkflowTextToV3: the one-shot boot rewrite of stored defs to
// the v3 step model. Pins: triggers stripped (FD-10) · node.move → spliced
// move step · review reject object → minted loop step · reject.move DROPPED
// (FD-9: no on-reject move-back) · dead retry keys dropped · idempotent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowV2 } from '@pc/domain';
import { migrateWorkflowTextToV3, serializeWorkflowV2 } from '@pc/workflows';

function yamlOf(doc: Record<string, unknown>): string {
  return serializeWorkflowV2(doc as unknown as WorkflowV2.Workflow);
}

test('v2 def with move property + reject object migrates to move/loop steps', () => {
  const yaml = `version: 2
id: legacy
name: Legacy
triggers:
  - kind: manual
nodes:
  - id: build
    kind: agent
    agent: writer
    task: build it
    retry:
      max_attempts: 2
    move: review-stage
    next: [gate]
  - id: gate
    kind: review
    reviewer: orchestrator
    reject:
      back_to: build
      max_iterations: 2
      carry:
        feedback: $self.output
      move: build-stage
`;
  const r = migrateWorkflowTextToV3(yaml, 'legacy');
  assert.equal(r.changed, true);
  if (!r.changed) return;
  assert.ok(r.workflow, `migrated def must validate: ${r.changed ? (r.errors ?? []).join('; ') : ''}`);
  const wf = r.workflow!;
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));

  // triggers gone
  assert.equal((wf as unknown as { triggers?: unknown }).triggers, undefined);

  // build's move property became a spliced move step
  const build = byId.get('build') as WorkflowV2.AgentNode;
  assert.equal((build as unknown as { move?: unknown }).move, undefined);
  assert.equal((build as unknown as { retry?: unknown }).retry, undefined);
  assert.deepEqual(build.next, ['build-move']);
  const move = byId.get('build-move') as WorkflowV2.MoveNode;
  assert.equal(move.kind, 'move');
  assert.equal(move.stage, 'review-stage');
  assert.deepEqual(move.next, ['gate'], 'the move step inherits the original forward path');

  // gate's reject object became a loop step; reject.move dropped whole
  const gate = byId.get('gate') as WorkflowV2.ReviewNode;
  assert.equal(gate.reject, 'gate-loop');
  const loop = byId.get('gate-loop') as WorkflowV2.LoopNode;
  assert.equal(loop.kind, 'loop');
  assert.equal(loop.back_to, 'build');
  assert.equal(loop.max_iterations, 2);
  assert.deepEqual(loop.carry, { feedback: '$self.output' });
  assert.equal((loop as unknown as { move?: unknown }).move, undefined, 'reject.move died with FD-9');

  // idempotent: a second pass is a no-op
  const again = migrateWorkflowTextToV3(r.yaml, 'legacy');
  assert.equal(again.changed, false);
});

test('a clean v3 def is untouched', () => {
  const clean = yamlOf({
    id: 'clean',
    name: 'Clean',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'writer', task: 'go', next: ['gate'] },
      { id: 'gate', kind: 'review', reviewer: 'human', reject: 'gate-loop' },
      { id: 'gate-loop', kind: 'loop', back_to: 'a' },
    ],
  });
  assert.equal(migrateWorkflowTextToV3(clean, 'clean').changed, false);
});

test('a def invalid for OTHER reasons keeps errors after the rewrite', () => {
  const yaml = `version: 2
id: broken
name: Broken
triggers: []
nodes:
  - id: a
    kind: agent
    agent: writer
    task: go
    next: [ghost]
`;
  const r = migrateWorkflowTextToV3(yaml, 'broken');
  assert.equal(r.changed, true);
  if (!r.changed) return;
  assert.equal(r.workflow, null);
  assert.ok(r.errors.some((e) => e.includes('unknown node "ghost"')));
  // The triggers key is still gone from the rewritten yaml.
  assert.ok(!r.yaml.includes('triggers'), 'rewritten yaml carries no triggers key');
});
