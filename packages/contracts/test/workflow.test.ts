import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveEventFrame,
  buildWorkflowRunChangedRefetchEnvelope,
  isWorkflowDefinitionChangedLiveEvent,
  isWorkflowDefinitionChangedLiveEventFrame,
  isWorkflowDefinitionDto,
  isWorkflowReviewChangedLiveEvent,
  isWorkflowRunChangedLiveEvent,
  isWorkflowRunChangedLiveEventFrame,
  isWorkflowRunDto,
  parseFireWorkflowRequest,
  parseWorkflowReviewRequest,
  toWorkflowRunChangedRefetchEnvelope,
  type WorkflowDefinitionChangedLiveEvent,
  type WorkflowDefinitionDto,
  type WorkflowReviewChangedLiveEvent,
  type WorkflowRunChangedLiveEvent,
  type WorkflowRunDto,
} from '../src/index.ts';

const run: WorkflowRunDto = {
  id: 'r1',
  projectId: 'p1',
  workflowSlug: 'deploy',
  workflowName: 'Deploy',
  definitionHash: 'abc123',
  status: 'running',
  rev: 2,
  workItemId: 'wi1',
  worktreePath: null,
  lastReason: null,
  createdAt: 1,
  startedAt: 2,
  endedAt: null,
  dagState: { nodes: {} },
};

const definition: WorkflowDefinitionDto = {
  id: 'wf1',
  slug: 'deploy',
  scope: 'project',
  projectId: 'p1',
  name: 'Deploy',
  displayName: null,
  description: null,
  status: 'active',
  disabled: false,
  yamlHash: 'hhh',
  updatedAt: 5,
};

function runChangedEvent(
  overrides: Partial<WorkflowRunChangedLiveEvent> = {},
): WorkflowRunChangedLiveEvent {
  return {
    id: 'evt-run',
    cursor: '10',
    scope: 'project',
    projectId: 'p1',
    type: 'workflow.run.changed',
    entity: 'workflow-run',
    entityId: 'r1',
    version: 2,
    createdAt: 1,
    payload: { reason: 'advanced', run },
    ...overrides,
  };
}

function reviewChangedEvent(
  overrides: Partial<WorkflowReviewChangedLiveEvent> = {},
): WorkflowReviewChangedLiveEvent {
  return {
    id: 'evt-rev',
    cursor: '11',
    scope: 'project',
    projectId: 'p1',
    type: 'workflow.review.changed',
    entity: 'workflow-review',
    entityId: 'r1',
    version: 2,
    createdAt: 1,
    payload: { runId: 'r1', nodeId: 'n1', flavor: 'human', state: 'pending', prompt: 'check' },
    ...overrides,
  };
}

function definitionChangedEvent(
  overrides: Partial<WorkflowDefinitionChangedLiveEvent> = {},
): WorkflowDefinitionChangedLiveEvent {
  return {
    id: 'evt-def',
    cursor: '12',
    scope: 'project',
    projectId: 'p1',
    type: 'workflow.definition.changed',
    entity: 'workflow-definition',
    entityId: 'wf1',
    version: null,
    createdAt: 1,
    payload: { change: 'updated', definition },
    ...overrides,
  };
}

test('WorkflowRunDto / WorkflowDefinitionDto guards stay narrow', () => {
  assert.equal(isWorkflowRunDto(run), true);
  assert.equal(isWorkflowRunDto({ ...run, status: 'bogus' }), false);
  assert.equal(isWorkflowRunDto({ ...run, dagState: null }), false);
  assert.equal(isWorkflowDefinitionDto(definition), true);
  assert.equal(isWorkflowDefinitionDto({ ...definition, scope: 'x' }), false);
});

test('workflow.run.changed live-event + frame guards', () => {
  const event = runChangedEvent();
  const frame = buildLiveEventFrame(event);
  assert.equal(isWorkflowRunChangedLiveEvent(event), true);
  assert.equal(isWorkflowRunChangedLiveEventFrame(frame), true);
  // scope must be project for run events
  assert.equal(isWorkflowRunChangedLiveEvent({ ...event, scope: 'global', projectId: null }), false);
  assert.equal(isWorkflowRunChangedLiveEvent({ ...event, type: 'workflow.review.changed' }), false);
});

test('workflow.review.changed + workflow.definition.changed guards', () => {
  assert.equal(isWorkflowReviewChangedLiveEvent(reviewChangedEvent()), true);
  assert.equal(
    isWorkflowReviewChangedLiveEvent({ ...reviewChangedEvent(), payload: { runId: 'r1' } }),
    false,
  );
  assert.equal(isWorkflowDefinitionChangedLiveEvent(definitionChangedEvent()), true);
  assert.equal(
    isWorkflowDefinitionChangedLiveEventFrame(buildLiveEventFrame(definitionChangedEvent())),
    true,
  );
});

test('run event adapts to legacy workflow-v2-run-changed (null without snapshot)', () => {
  assert.deepEqual(toWorkflowRunChangedRefetchEnvelope(runChangedEvent()), {
    type: 'workflow-v2-run-changed',
    projectId: 'p1',
    run,
  });
  assert.equal(
    toWorkflowRunChangedRefetchEnvelope(runChangedEvent({ payload: { reason: 'cancelled' } })),
    null,
  );
  assert.deepEqual(buildWorkflowRunChangedRefetchEnvelope({ projectId: 'p1', run }).type, 'workflow-v2-run-changed');
});

test('fire + review request parsers validate input', () => {
  assert.deepEqual(parseFireWorkflowRequest({ workItemId: 'wi1' }), {
    ok: true,
    value: { workItemId: 'wi1' },
  });
  assert.deepEqual(parseFireWorkflowRequest(undefined), { ok: true, value: {} });
  assert.equal(parseFireWorkflowRequest({ projectId: '' }).ok, false);
  assert.equal(parseFireWorkflowRequest({ workItemId: '' }).ok, false);

  assert.deepEqual(parseWorkflowReviewRequest({ runId: 'r1', nodeId: 'n1', decision: 'approve' }), {
    ok: true,
    value: { runId: 'r1', nodeId: 'n1', decision: 'approve' },
  });
  assert.equal(parseWorkflowReviewRequest({ runId: 'r1', nodeId: 'n1', decision: 'maybe' }).ok, false);
  assert.equal(parseWorkflowReviewRequest({ nodeId: 'n1', decision: 'approve' }).ok, false);
});
