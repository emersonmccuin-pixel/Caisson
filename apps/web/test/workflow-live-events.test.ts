import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scanWorkflowLiveEvents,
  shouldAcceptWorkflowWsEnvelope,
  workflowRunChangedLiveEventFromUnknown,
} from '../src/features/workflows/live-events.ts';
import type { WorkflowRunDto } from '@pc/contracts';

function run(over: Partial<WorkflowRunDto> = {}): WorkflowRunDto {
  return {
    id: 'r1',
    projectId: 'p1',
    workflowSlug: 'deploy',
    workflowName: 'Deploy',
    definitionHash: 'h',
    status: 'running',
    rev: 1,
    trigger: 'manual',
    stageId: null,
    workItemId: null,
    worktreePath: null,
    lastReason: null,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
    dagState: { nodes: {} },
    ...over,
  };
}

function runFrame(id: string, cursor: string, r: WorkflowRunDto, reason = 'advanced') {
  return {
    type: 'live-event',
    event: {
      id,
      cursor,
      scope: 'project',
      projectId: 'p1',
      type: 'workflow.run.changed',
      entity: 'workflow-run',
      entityId: r.id,
      version: r.rev,
      createdAt: 1,
      payload: { reason, run: r },
    },
  };
}

function reviewFrame(id: string, cursor: string, state: 'pending' | 'approved') {
  return {
    type: 'live-event',
    event: {
      id,
      cursor,
      scope: 'project',
      projectId: 'p1',
      type: 'workflow.review.changed',
      entity: 'workflow-review',
      entityId: 'r1',
      version: 1,
      createdAt: 1,
      payload: { runId: 'r1', nodeId: 'n1', flavor: 'human', state },
    },
  };
}

test('workflow ws filter accepts canonical frames + matching-project legacy', () => {
  assert.equal(shouldAcceptWorkflowWsEnvelope(runFrame('e1', '1', run()), 'p1'), true);
  assert.equal(
    shouldAcceptWorkflowWsEnvelope({ type: 'workflow-v2-run-changed', projectId: 'p1' }, 'p1'),
    true,
  );
  assert.equal(
    shouldAcceptWorkflowWsEnvelope({ type: 'workflow-v2-run-changed', projectId: 'p2' }, 'p1'),
    false,
  );
  assert.equal(shouldAcceptWorkflowWsEnvelope({ type: 'pod-changed' }, 'p1'), false);
});

test('scan applies rev-aware run upserts and dedupes by event id', () => {
  const seen = new Set<string>();
  const events = [
    runFrame('e1', '5', run({ rev: 2, status: 'running' })),
    runFrame('e1', '5', run({ rev: 2, status: 'running' })), // dup id
    runFrame('e2', '4', run({ rev: 1, status: 'running' })), // older rev — ignored
  ];
  const result = scanWorkflowLiveEvents(events, 0, seen);
  assert.equal(result.runs.get('r1')?.rev, 2);
  assert.equal(result.latestCursor, '4');
});

test('review-pending tracking adds then clears on resolve / terminal run', () => {
  const seen = new Set<string>();
  let result = scanWorkflowLiveEvents([reviewFrame('rv1', '6', 'pending')], 0, seen);
  assert.equal(result.reviewPending.has('r1'), true);

  result = scanWorkflowLiveEvents([reviewFrame('rv2', '7', 'approved')], 0, seen, result);
  assert.equal(result.reviewPending.has('r1'), false);

  // a completed run frame also clears pending
  result = scanWorkflowLiveEvents([reviewFrame('rv3', '8', 'pending')], 0, seen, result);
  assert.equal(result.reviewPending.has('r1'), true);
  result = scanWorkflowLiveEvents(
    [runFrame('e9', '9', run({ rev: 5, status: 'completed' }))],
    0,
    seen,
    result,
  );
  assert.equal(result.reviewPending.has('r1'), false);
});

test('run-event extractor returns the event from a frame or raw event', () => {
  assert.equal(workflowRunChangedLiveEventFromUnknown(runFrame('e1', '1', run()))?.id, 'e1');
  assert.equal(workflowRunChangedLiveEventFromUnknown({ type: 'x' }), null);
});
