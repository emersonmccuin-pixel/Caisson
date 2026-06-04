import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  definitionHashOf,
  toWorkflowDefinitionDto,
  toWorkflowRunDto,
  WorkflowAdapterError,
  type WorkflowDefinitionRowLike,
} from '../src/workflows/adapters.ts';
import { isWorkflowDefinitionDto, isWorkflowRunDto } from '@pc/contracts';
import type { WorkflowRunV2Record } from '@pc/db';

const snapshot = JSON.stringify({ id: 'deploy', name: 'Deploy', nodes: [] });

const runRow: WorkflowRunV2Record = {
  id: 'r1',
  workflowId: 'deploy',
  workflowName: 'Deploy',
  projectId: 'p1',
  workItemId: 'wi1',
  stageId: null,
  triggeredBySessionId: null,
  status: 'running',
  workflowYamlSnapshot: snapshot,
  worktreePath: null,
  dagState: { nodes: { a: { state: 'completed' } } },
  triggerContext: {},
  metadata: {},
  lastReason: null,
  rev: 7,
  createdAt: 1,
  startedAt: 2,
  endedAt: null,
  lastActivityAt: 2,
};

const defRow: WorkflowDefinitionRowLike = {
  id: 'wf1',
  slug: 'deploy',
  scope: 'project',
  projectId: 'p1',
  name: 'Deploy',
  displayName: 'Deploy It',
  description: null,
  status: 'active',
  disabled: false,
  yamlHash: 'cafef00d',
  updatedAt: 9,
};

test('toWorkflowRunDto maps the row + derives a stable snapshot hash', () => {
  const dto = toWorkflowRunDto(runRow);
  assert.equal(isWorkflowRunDto(dto), true);
  assert.equal(dto.workflowSlug, 'deploy');
  assert.equal(dto.rev, 7);
  assert.equal(dto.definitionHash, definitionHashOf(snapshot));
  // Version-pinning invariant: the executed-graph fingerprint is taken from
  // the frozen snapshot, so re-deriving from the same snapshot is stable.
  assert.equal(toWorkflowRunDto(runRow).definitionHash, dto.definitionHash);
  assert.deepEqual(dto.dagState.nodes.a, { state: 'completed' });
});

test('toWorkflowDefinitionDto maps the row', () => {
  const dto = toWorkflowDefinitionDto(defRow);
  assert.equal(isWorkflowDefinitionDto(dto), true);
  assert.equal(dto.displayName, 'Deploy It');
  assert.equal(dto.yamlHash, 'cafef00d');
});

test('adapters fail loud on a structurally invalid row', () => {
  assert.throws(() => toWorkflowRunDto({} as WorkflowRunV2Record), WorkflowAdapterError);
  assert.throws(
    () => toWorkflowDefinitionDto({} as WorkflowDefinitionRowLike),
    WorkflowAdapterError,
  );
});
