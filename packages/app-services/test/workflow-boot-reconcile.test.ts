import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  reconcileWorkflowRunsOnBoot,
  WORKFLOW_INTERRUPTED_ON_BOOT_REASON,
} from '../src/workflows/boot-reconcile.ts';
import type { WorkflowRunV2Record } from '@pc/db';

function makeRow(id: string, status: WorkflowRunV2Record['status']): WorkflowRunV2Record {
  return {
    id,
    workflowId: 'deploy',
    workflowName: 'Deploy',
    projectId: 'p1',
    workItemId: null,
    stageId: null,
    triggeredBySessionId: null,
    status,
    workflowYamlSnapshot: '{}',
    worktreePath: null,
    dagState: { nodes: {} },
    triggerContext: {},
    metadata: {},
    lastReason: null,
    rev: 1,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
    lastActivityAt: 1,
  };
}

test('fail-closes running + pending, leaves paused untouched, counts correct', () => {
  const failed: Array<{ id: string; reason: string }> = [];
  const result = reconcileWorkflowRunsOnBoot({
    listRuns: () => [
      makeRow('running1', 'running'),
      makeRow('paused1', 'paused'),
      makeRow('pending1', 'pending'),
    ],
    failClosed: (run, reason) => failed.push({ id: run.id, reason }),
  });

  assert.equal(result.scanned, 3);
  assert.equal(result.failed, 2);
  assert.equal(result.skippedPaused, 1);
  assert.deepEqual(failed.map((f) => f.id).sort(), ['pending1', 'running1']);
  assert.equal(failed[0]!.reason, WORKFLOW_INTERRUPTED_ON_BOOT_REASON);
});

test('no non-terminal runs => no fail-closures', () => {
  const result = reconcileWorkflowRunsOnBoot({
    listRuns: () => [],
    failClosed: () => assert.fail('should not be called'),
  });
  assert.deepEqual(result, { scanned: 0, failed: 0, skippedPaused: 0, reDriven: 0 });
});

test('running run with only merge nodes in-flight is re-driven, not fail-closed', () => {
  const failedIds: string[] = [];
  const reDrivenIds: string[] = [];

  // A run whose dagState has a merge node in `running` state.
  const mergeRun: WorkflowRunV2Record = {
    id: 'merge-run-1',
    workflowId: 'deploy',
    workflowName: 'Deploy',
    projectId: 'p1',
    workItemId: null,
    stageId: null,
    triggeredBySessionId: null,
    status: 'running',
    workflowYamlSnapshot: JSON.stringify({
      id: 'deploy',
      name: 'Deploy',
      nodes: [{ id: 'merge', kind: 'merge', target: 'dev' }],
    }),
    worktreePath: '/wt/agent-AAAA1234',
    dagState: { nodes: { merge: { state: 'running' } } },
    triggerContext: {},
    metadata: {},
    lastReason: null,
    rev: 1,
    createdAt: 1,
    startedAt: 1,
    endedAt: null,
    lastActivityAt: 1,
  };

  const result = reconcileWorkflowRunsOnBoot({
    listRuns: () => [mergeRun, makeRow('normal-run', 'running')],
    failClosed: (run) => failedIds.push(run.id),
    reDriveMerge: (run) => reDrivenIds.push(run.id),
  });

  assert.equal(result.scanned, 2);
  assert.equal(result.reDriven, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(reDrivenIds, ['merge-run-1'], 'merge run is re-driven');
  assert.deepEqual(failedIds, ['normal-run'], 'normal run is fail-closed');
});

test('running run with merge nodes in-flight falls back to fail-close when reDriveMerge absent', () => {
  const failedIds: string[] = [];

  const mergeRun: WorkflowRunV2Record = {
    id: 'merge-run-2',
    workflowId: 'deploy',
    workflowName: 'Deploy',
    projectId: 'p1',
    workItemId: null,
    stageId: null,
    triggeredBySessionId: null,
    status: 'running',
    workflowYamlSnapshot: JSON.stringify({
      id: 'deploy',
      name: 'Deploy',
      nodes: [{ id: 'merge', kind: 'merge', target: 'dev' }],
    }),
    worktreePath: '/wt/agent-BBBB5678',
    dagState: { nodes: { merge: { state: 'running' } } },
    triggerContext: {},
    metadata: {},
    lastReason: null,
    rev: 1,
    createdAt: 1,
    startedAt: 1,
    endedAt: null,
    lastActivityAt: 1,
  };

  // No reDriveMerge dep → falls back to fail-close.
  const result = reconcileWorkflowRunsOnBoot({
    listRuns: () => [mergeRun],
    failClosed: (run) => failedIds.push(run.id),
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.reDriven, 0);
  assert.deepEqual(failedIds, ['merge-run-2']);
});
