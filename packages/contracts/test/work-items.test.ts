import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveEventFrame,
  buildWorkItemChangedRefetchEnvelope,
  isAttachmentChangedLiveEvent,
  isAttachmentDto,
  isFieldSchemaDto,
  isFieldSchemaListChangedLiveEvent,
  isStageDto,
  isStageListChangedLiveEvent,
  isStageListChangedLiveEventFrame,
  isWorkItemChangedLiveEvent,
  isWorkItemChangedLiveEventFrame,
  isWorkItemDto,
  parseCreateAttachmentRequest,
  parseCreateWorkItemRequest,
  parseMoveWorkItemRequest,
  parsePatchWorkItemRequest,
  parseReplaceFieldSchemasRequest,
  toStagesChangedRefetchEnvelope,
  toWorkItemChangedRefetchEnvelope,
  type AttachmentDto,
  type StageListChangedLiveEvent,
  type WorkItemChangedLiveEvent,
  type WorkItemDto,
} from '../src/index.ts';

const workItem: WorkItemDto = {
  id: 'wi1',
  projectId: 'p1',
  parentId: null,
  callsign: 'pc-1',
  position: 0,
  title: 'Do the thing',
  body: 'details',
  stageId: 'todo',
  status: 'pending',
  statusReason: null,
  type: 'task',
  fields: {},
  version: 3,
  createdAt: 1,
  updatedAt: 2,
  deletedAt: null,
  isWorkflowRoot: false,
  areaId: null,
  focusedAt: null,
};

const attachment: AttachmentDto = {
  id: 'a1',
  workItemId: 'wi1',
  kind: 'text',
  name: 'report.md',
  content: 'hello',
  contentType: null,
  runId: null,
  createdBySessionId: null,
  source: 'agent',
  agentName: 'writer',
  nodeId: null,
  createdAt: 5,
};

function workItemChangedEvent(
  overrides: Partial<WorkItemChangedLiveEvent> = {},
): WorkItemChangedLiveEvent {
  return {
    id: 'evt1',
    cursor: '5',
    scope: 'project',
    projectId: 'p1',
    type: 'work-item.changed',
    entity: 'work-item',
    entityId: 'wi1',
    version: 3,
    createdAt: 9,
    payload: { reason: 'moved', workItem },
    ...overrides,
  };
}

function stageListChangedEvent(
  overrides: Partial<StageListChangedLiveEvent> = {},
): StageListChangedLiveEvent {
  return {
    id: 'evt2',
    cursor: '6',
    scope: 'project',
    projectId: 'p1',
    type: 'stage.list.changed',
    entity: 'stage',
    entityId: null,
    version: 4,
    createdAt: 10,
    payload: {
      stagesRev: 4,
      reason: 'replaced',
      stages: [{ id: 'todo', name: 'Todo', position: 0 }],
    },
    ...overrides,
  };
}

test('WorkItemDto guard accepts a full row and rejects drift', () => {
  assert.equal(isWorkItemDto(workItem), true);
  assert.equal(isWorkItemDto({ ...workItem, status: 'bogus' }), false);
  assert.equal(isWorkItemDto({ ...workItem, type: 'epic' }), false);
  assert.equal(isWorkItemDto({ ...workItem, version: '3' }), false);
});

test('create/patch/move parsers validate required fields', () => {
  assert.deepEqual(parseCreateWorkItemRequest({ stageId: 'todo', title: ' Hi ' }), {
    ok: true,
    value: { stageId: 'todo', title: 'Hi' },
  });
  assert.equal(parseCreateWorkItemRequest({ title: 'x' }).ok, false);
  assert.equal(parseCreateWorkItemRequest({ stageId: 'todo' }).ok, false);

  assert.deepEqual(parsePatchWorkItemRequest({ expectedVersion: 2, title: 'New' }), {
    ok: true,
    value: { expectedVersion: 2, title: 'New' },
  });
  assert.equal(parsePatchWorkItemRequest({ title: 'no version' }).ok, false);

  assert.deepEqual(parseMoveWorkItemRequest({ expectedVersion: 2, stageId: 'doing' }), {
    ok: true,
    value: { expectedVersion: 2, stageId: 'doing' },
  });
  assert.equal(parseMoveWorkItemRequest({ stageId: 'doing' }).ok, false);
  assert.equal(parseMoveWorkItemRequest({ expectedVersion: 2 }).ok, false);
});

test('work-item.changed live event + frame guards stay narrow', () => {
  const event = workItemChangedEvent();
  const frame = buildLiveEventFrame(event);
  assert.equal(isWorkItemChangedLiveEvent(event), true);
  assert.equal(isWorkItemChangedLiveEventFrame(frame), true);
  // scope/project invariant: project-scoped events must carry projectId
  assert.equal(isWorkItemChangedLiveEvent({ ...event, scope: 'global', projectId: null }), false);
  assert.equal(isWorkItemChangedLiveEvent({ ...event, type: 'project.changed' }), false);
  assert.equal(
    isWorkItemChangedLiveEvent({ ...event, payload: { reason: 'nope' } }),
    false,
  );
});

test('work-item.changed adapts to the legacy full-snapshot envelope', () => {
  assert.deepEqual(toWorkItemChangedRefetchEnvelope(workItemChangedEvent()), {
    type: 'work-item-changed',
    projectId: 'p1',
    workItem,
  });
  // No snapshot in payload -> no legacy envelope (legacy channel is snapshot-only)
  assert.equal(
    toWorkItemChangedRefetchEnvelope(
      workItemChangedEvent({ payload: { reason: 'soft-deleted' } }),
    ),
    null,
  );
  assert.deepEqual(buildWorkItemChangedRefetchEnvelope({ projectId: 'p1', workItem }), {
    type: 'work-item-changed',
    projectId: 'p1',
    workItem,
  });
});

test('stage.list.changed guards + legacy projection', () => {
  const event = stageListChangedEvent();
  assert.equal(isStageDto({ id: 'a', name: 'A', position: 0 }), true);
  assert.equal(isStageDto({ id: 'a', name: 'A' }), false);
  assert.equal(isStageListChangedLiveEvent(event), true);
  assert.equal(isStageListChangedLiveEventFrame(buildLiveEventFrame(event)), true);
  assert.equal(isStageListChangedLiveEvent({ ...event, entityId: 'x' }), false);
  assert.deepEqual(toStagesChangedRefetchEnvelope(event), {
    type: 'stages-changed',
    projectId: 'p1',
    stagesRev: 4,
    stages: [{ id: 'todo', name: 'Todo', position: 0 }],
  });
});

test('attachment + field-schema DTO guards and requests', () => {
  assert.equal(isAttachmentDto(attachment), true);
  assert.equal(isAttachmentDto({ ...attachment, source: 'bot' }), false);
  assert.deepEqual(
    parseCreateAttachmentRequest({ workItemId: 'wi1', name: 'x.md', content: 'c' }),
    { ok: true, value: { workItemId: 'wi1', kind: 'text', name: 'x.md', content: 'c' } },
  );
  assert.equal(parseCreateAttachmentRequest({ name: 'x', content: 'c' }).ok, false);

  assert.equal(
    isFieldSchemaDto({
      id: 'f1',
      projectId: 'p1',
      key: 'sev',
      label: 'Severity',
      type: 'enum',
      options: ['low', 'high'],
      required: true,
      order: 0,
    }),
    true,
  );
  assert.deepEqual(
    parseReplaceFieldSchemasRequest({
      items: [{ key: 'sev', label: 'Severity', type: 'text', required: false }],
    }),
    {
      ok: true,
      value: { items: [{ key: 'sev', label: 'Severity', type: 'text', required: false }] },
    },
  );
  assert.equal(parseReplaceFieldSchemasRequest({ items: [{ key: 'x' }] }).ok, false);

  const fsEvent = {
    id: 'e3',
    cursor: '7',
    scope: 'project' as const,
    projectId: 'p1',
    type: 'field-schema.list.changed',
    entity: 'field-schema' as const,
    // T3.2b Q1-A — keyed by projectId (was null) so it enters the live store.
    entityId: 'p1',
    version: null,
    createdAt: 1,
    payload: {
      reason: 'replaced' as const,
      schemas: [
        {
          id: 'f1',
          projectId: 'p1',
          key: 'sev',
          label: 'Severity',
          type: 'text' as const,
          required: false,
          order: 0,
        },
      ],
    },
  };
  assert.equal(isFieldSchemaListChangedLiveEvent(fsEvent), true);
  // T3.2b Q1-A — the guard now requires a string entityId; null is rejected.
  assert.equal(isFieldSchemaListChangedLiveEvent({ ...fsEvent, entityId: null }), false);

  const attEvent = {
    id: 'e4',
    cursor: '8',
    scope: 'project' as const,
    projectId: 'p1',
    type: 'attachment.changed',
    entity: 'attachment' as const,
    entityId: 'a1',
    version: null,
    createdAt: 1,
    payload: { reason: 'created' as const, workItemId: 'wi1', attachment },
  };
  assert.equal(isAttachmentChangedLiveEvent(attEvent), true);
});
