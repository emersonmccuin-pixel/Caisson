import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WorkItemMutationGateway,
  type WorkItemGatewayDeps,
} from '../src/work-items/gateway.ts';
import {
  isWorkItemChangedLiveEvent,
  isStageListChangedLiveEvent,
  isFieldSchemaListChangedLiveEvent,
  isAttachmentChangedLiveEvent,
} from '@pc/contracts';
import type { DbExecutor, InsertLiveEventDraft, LiveOutboxEvent } from '@pc/db';
import type { FieldSchema, Stage, WorkItem } from '@pc/domain';

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
  fields: {},
  version: 4,
  createdAt: 1,
  updatedAt: 2,
  deletedAt: null,
  history: [],
  isWorkflowRoot: false,
  callsign: 'pc-1',
};

/** Test harness: a fake transaction that records inserted drafts, plus an
 *  insertLiveEvent stub that turns a draft into a LiveOutboxEvent. Rollback
 *  is simulated by having `mutate` throw — the harness records nothing then. */
function makeGateway(): {
  gateway: WorkItemMutationGateway;
  inserted: InsertLiveEventDraft[];
} {
  const inserted: InsertLiveEventDraft[] = [];
  let seq = 0;
  const fakeInsert = (<TPayload>(
    _db: DbExecutor,
    draft: InsertLiveEventDraft<TPayload>,
  ): LiveOutboxEvent<TPayload> => {
    inserted.push(draft as InsertLiveEventDraft);
    seq += 1;
    return {
      id: `evt-${seq}`,
      cursor: String(seq),
      scope: draft.scope,
      projectId: draft.projectId,
      type: draft.type,
      entity: draft.entity,
      entityId: draft.entityId,
      version: draft.version,
      createdAt: 100 + seq,
      payload: draft.payload,
    };
  }) as WorkItemGatewayDeps['insertLiveEvent'];

  const deps: WorkItemGatewayDeps = {
    // Synchronous fake transaction: run fn with a dummy executor; if it
    // throws, nothing was appended (the real insert only runs inside fn).
    transaction: (fn) => fn({} as DbExecutor),
    insertLiveEvent: fakeInsert,
  };
  return { gateway: new WorkItemMutationGateway(deps), inserted };
}

test('commitWorkItemChange emits exactly one canonical work-item.changed fact', () => {
  const { gateway, inserted } = makeGateway();
  const result = gateway.commitWorkItemChange({
    projectId: 'p1',
    reason: 'moved',
    mutate: () => ({ ...wi, stageId: 'doing' }),
  });
  assert.equal(inserted.length, 1);
  assert.equal(isWorkItemChangedLiveEvent(result.liveEvent), true);
  assert.equal(result.liveEvent.type, 'work-item.changed');
  assert.equal(result.liveEvent.version, 4);
  assert.equal(result.legacyEvent?.type, 'work-item-changed');
  assert.equal(result.workItem.stageId, 'doing');
});

test('verification reasons (verified/approved/auto-advanced) emit work-item facts', () => {
  for (const reason of ['verified', 'approved', 'rejected', 'auto-advanced'] as const) {
    const { gateway, inserted } = makeGateway();
    const result = gateway.announceWorkItemChange({ projectId: 'p1', reason, workItem: wi });
    assert.equal(inserted.length, 1);
    assert.equal(result.liveEvent.payload.reason, reason);
    assert.equal(isWorkItemChangedLiveEvent(result.liveEvent), true);
  }
});

test('a mutation that throws emits NOTHING (rollback semantics)', () => {
  const { gateway, inserted } = makeGateway();
  assert.throws(() =>
    gateway.commitWorkItemChange({
      projectId: 'p1',
      reason: 'patched',
      mutate: () => {
        throw new Error('boom');
      },
    }),
  );
  assert.equal(inserted.length, 0);
});

test('a mutation returning null emits NOTHING and throws', () => {
  const { gateway, inserted } = makeGateway();
  assert.throws(() =>
    gateway.commitWorkItemChange({ projectId: 'p1', reason: 'patched', mutate: () => null }),
  );
  assert.equal(inserted.length, 0);
});

test('commitStageListChange emits exactly one stage.list.changed fact', () => {
  const { gateway, inserted } = makeGateway();
  const stages: Stage[] = [{ id: 'todo', name: 'Todo', order: 0 }];
  const result = gateway.commitStageListChange({
    projectId: 'p1',
    mutate: () => ({ stagesRev: 5, stages }),
  });
  assert.equal(inserted.length, 1);
  assert.equal(isStageListChangedLiveEvent(result.liveEvent), true);
  assert.equal(result.liveEvent.version, 5);
  assert.equal(result.legacyEvent.type, 'stages-changed');
  assert.equal(result.stages[0]!.position, 0);
});

test('commitFieldSchemaListChange emits one field-schema.list.changed fact', () => {
  const { gateway, inserted } = makeGateway();
  const schemas: FieldSchema[] = [
    { id: 'f1', projectId: 'p1', key: 'sev', label: 'Sev', type: 'text', required: false, order: 0 },
  ];
  const result = gateway.commitFieldSchemaListChange({ projectId: 'p1', mutate: () => schemas });
  assert.equal(inserted.length, 1);
  assert.equal(isFieldSchemaListChangedLiveEvent(result.liveEvent), true);
  assert.equal(result.legacyEvent.type, 'field-schemas-changed');
  // T3.2b Q1-A — the draft is keyed by projectId (was null) so it enters the
  // client live store.
  assert.equal(inserted[0]!.entityId, 'p1');
  assert.equal(result.liveEvent.entityId, 'p1');
});

test('commitAttachmentChange emits one attachment.changed fact for create + delete', () => {
  for (const reason of ['created', 'deleted'] as const) {
    const { gateway, inserted } = makeGateway();
    const result = gateway.commitAttachmentChange({
      projectId: 'p1',
      workItemId: 'wi1',
      reason,
      mutate: () => ({ attachmentId: 'a1' }),
    });
    assert.equal(inserted.length, 1);
    assert.equal(isAttachmentChangedLiveEvent(result.liveEvent), true);
    assert.equal(result.liveEvent.payload.reason, reason);
    assert.equal(result.legacyEvent.type, 'attachment-changed');
  }
});
