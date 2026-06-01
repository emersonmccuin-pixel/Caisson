import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveEventFrame,
  isAreaChangedLiveEvent,
  isAreaChangedLiveEventFrame,
  isAreaDto,
  isAreaMutationReason,
  isWorkItemDto,
  parseCreateAreaRequest,
  parsePatchAreaRequest,
  parseReorderAreasRequest,
  type AreaChangedLiveEvent,
  type AreaDto,
  type WorkItemDto,
} from '../src/index.ts';

const area: AreaDto = {
  id: 'a1',
  projectId: 'p1',
  name: 'Bugs',
  summary: 'all the bugs',
  sortOrder: 0,
  version: 1,
  createdAt: 1,
  updatedAt: 2,
  deletedAt: null,
};

function areaChangedEvent(overrides: Partial<AreaChangedLiveEvent> = {}): AreaChangedLiveEvent {
  return {
    id: 'evt1',
    cursor: '9',
    scope: 'project',
    projectId: 'p1',
    type: 'area.changed',
    entity: 'area',
    entityId: 'a1',
    version: 1,
    createdAt: 9,
    payload: { reason: 'created', area },
    ...overrides,
  };
}

test('AreaDto guard accepts a full row and rejects drift', () => {
  assert.equal(isAreaDto(area), true);
  assert.equal(isAreaDto({ ...area, sortOrder: '0' }), false);
  assert.equal(isAreaDto({ ...area, name: 5 }), false);
  assert.equal(isAreaDto({ ...area, deletedAt: 99 }), true);
  assert.equal(isAreaDto({ ...area, deletedAt: 'no' }), false);
});

test('isAreaMutationReason narrows the reason set', () => {
  for (const r of ['created', 'patched', 'reordered', 'deleted']) {
    assert.equal(isAreaMutationReason(r), true);
  }
  assert.equal(isAreaMutationReason('moved'), false);
});

test('create parser requires a non-empty name + trims it', () => {
  assert.deepEqual(parseCreateAreaRequest({ name: ' Bugs ' }), {
    ok: true,
    value: { name: 'Bugs' },
  });
  assert.deepEqual(parseCreateAreaRequest({ name: 'X', summary: 'hi' }), {
    ok: true,
    value: { name: 'X', summary: 'hi' },
  });
  assert.equal(parseCreateAreaRequest({ name: '   ' }).ok, false);
  assert.equal(parseCreateAreaRequest({}).ok, false);
});

test('patch parser requires expectedVersion + at least one field', () => {
  assert.deepEqual(parsePatchAreaRequest({ expectedVersion: 2, name: 'New' }), {
    ok: true,
    value: { expectedVersion: 2, name: 'New' },
  });
  assert.deepEqual(parsePatchAreaRequest({ expectedVersion: 2, summary: 's' }), {
    ok: true,
    value: { expectedVersion: 2, summary: 's' },
  });
  assert.equal(parsePatchAreaRequest({ name: 'x' }).ok, false);
  assert.equal(parsePatchAreaRequest({ expectedVersion: 2 }).ok, false);
  assert.equal(parsePatchAreaRequest({ expectedVersion: 2, name: '  ' }).ok, false);
});

test('reorder parser validates the id array', () => {
  assert.deepEqual(parseReorderAreasRequest({ orderedIds: ['a', 'b'] }), {
    ok: true,
    value: { orderedIds: ['a', 'b'] },
  });
  assert.equal(parseReorderAreasRequest({ orderedIds: 'a' }).ok, false);
  assert.equal(parseReorderAreasRequest({ orderedIds: ['a', ''] }).ok, false);
  assert.equal(parseReorderAreasRequest({}).ok, false);
});

test('area.changed live event + frame guards stay narrow', () => {
  const event = areaChangedEvent();
  assert.equal(isAreaChangedLiveEvent(event), true);
  assert.equal(isAreaChangedLiveEventFrame(buildLiveEventFrame(event)), true);
  // reorder shape: areas array + null entityId/version
  const reorder = areaChangedEvent({
    entityId: null,
    version: null,
    payload: { reason: 'reordered', areas: [area, { ...area, id: 'a2', sortOrder: 1 }] },
  });
  assert.equal(isAreaChangedLiveEvent(reorder), true);
  // project-scope invariant + wrong type/payload rejected
  assert.equal(isAreaChangedLiveEvent({ ...event, scope: 'global', projectId: null }), false);
  assert.equal(isAreaChangedLiveEvent({ ...event, type: 'work-item.changed' }), false);
  assert.equal(isAreaChangedLiveEvent({ ...event, payload: { reason: 'nope' } }), false);
});

test('work-item DTO carries areaId (string or null)', () => {
  const wi: WorkItemDto = {
    id: 'wi1',
    projectId: 'p1',
    parentId: null,
    callsign: 'pc-1',
    position: 0,
    title: 'T',
    body: '',
    stageId: 'todo',
    status: 'pending',
    statusReason: null,
    type: 'task',
    fields: {},
    version: 1,
    createdAt: 1,
    updatedAt: 2,
    deletedAt: null,
    isAgentTask: false,
    isWorkflowRoot: false,
    ephemeral: false,
    acceptanceCriteria: null,
    expectedOutput: null,
    verificationTier: null,
    verificationStatus: null,
    verificationNotes: null,
    assignedAgentRunId: null,
    worktreePath: null,
    areaId: 'a1',
  };
  assert.equal(isWorkItemDto(wi), true);
  assert.equal(isWorkItemDto({ ...wi, areaId: null }), true);
  assert.equal(isWorkItemDto({ ...wi, areaId: 5 }), false);
});
