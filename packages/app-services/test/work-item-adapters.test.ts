import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WorkItemAdapterError,
  normalizeWorkItemListResponse,
  toAttachmentDto,
  toFieldSchemaDto,
  toItemsCursorListBody,
  toStageDto,
  toStageDtos,
  toWorkItemDto,
  toWorkItemsListBody,
} from '../src/work-items/adapters.ts';
import { isAttachmentDto, isFieldSchemaDto, isStageDto, isWorkItemDto } from '@pc/contracts';
import type { Attachment, FieldSchema, Stage, WorkItem } from '@pc/domain';

const wi: WorkItem = {
  id: 'wi1',
  projectId: 'p1',
  parentId: null,
  position: 0,
  title: 'T',
  body: 'B',
  stageId: 'todo',
  status: 'pending',
  statusReason: null,
  type: 'task',
  fields: { sev: 'high' },
  version: 2,
  createdAt: 1,
  updatedAt: 2,
  deletedAt: null,
  history: [],
  isAgentTask: false,
  // isWorkflowRoot intentionally omitted -> adapter defaults to false
  ephemeral: false,
  acceptanceCriteria: null,
  expectedOutput: null,
  verificationTier: null,
  verificationStatus: null,
  verificationNotes: null,
  assignedAgentRunId: null,
  worktreePath: null,
  callsign: 'pc-1',
};

test('toWorkItemDto round-trips into a valid DTO and defaults isWorkflowRoot', () => {
  const dto = toWorkItemDto(wi);
  assert.equal(isWorkItemDto(dto), true);
  assert.equal(dto.isWorkflowRoot, false);
  assert.deepEqual(dto.fields, { sev: 'high' });
  assert.equal(dto.callsign, 'pc-1');
});

test('toStageDto maps order -> position and carries flags; backfills rev', () => {
  const stage: Stage = { id: 'todo', name: 'Todo', order: 3, isDone: true };
  const dto = toStageDto(stage);
  assert.equal(isStageDto(dto), true);
  assert.equal(dto.position, 3);
  assert.equal(dto.isDone, true);
  const withRev = toStageDtos([stage], 7);
  assert.equal(withRev[0]!.rev, 7);
});

test('toFieldSchemaDto + toAttachmentDto produce valid DTOs', () => {
  const fs: FieldSchema = {
    id: 'f1',
    projectId: 'p1',
    key: 'sev',
    label: 'Severity',
    type: 'enum',
    options: ['low', 'high'],
    required: true,
    order: 0,
  };
  assert.equal(isFieldSchemaDto(toFieldSchemaDto(fs)), true);

  const att: Attachment = {
    id: 'a1',
    workItemId: 'wi1',
    kind: 'text',
    name: 'r.md',
    content: 'x',
    contentType: null,
    runId: null,
    createdBySessionId: null,
    source: 'agent',
    agentName: 'writer',
    nodeId: null,
    createdAt: 9,
  };
  assert.equal(isAttachmentDto(toAttachmentDto(att)), true);
});

test('list-shape normalizer accepts both legacy shapes and fails loud otherwise', () => {
  const dto = toWorkItemDto(wi);
  assert.deepEqual(normalizeWorkItemListResponse(toWorkItemsListBody([dto])), {
    items: [dto],
    nextCursor: null,
  });
  assert.deepEqual(normalizeWorkItemListResponse(toItemsCursorListBody([dto], 'cur1')), {
    items: [dto],
    nextCursor: 'cur1',
  });
  assert.throws(() => normalizeWorkItemListResponse({ nope: 1 }), WorkItemAdapterError);
  assert.throws(() => normalizeWorkItemListResponse(null), WorkItemAdapterError);
});

test('adapters fail loud on structurally invalid rows', () => {
  assert.throws(() => toWorkItemDto({} as unknown as WorkItem), WorkItemAdapterError);
  assert.throws(() => toStageDto({} as unknown as Stage), WorkItemAdapterError);
});
