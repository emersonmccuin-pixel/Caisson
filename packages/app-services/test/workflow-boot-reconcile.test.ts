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
    trigger: 'manual',
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
  assert.deepEqual(result, { scanned: 0, failed: 0, skippedPaused: 0 });
});
