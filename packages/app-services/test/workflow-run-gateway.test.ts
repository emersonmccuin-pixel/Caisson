import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WorkflowRunMutationGateway,
  type WorkflowRunGatewayDeps,
} from '../src/workflows/run-gateway.ts';
import {
  isWorkflowRunChangedLiveEvent,
  isWorkflowReviewChangedLiveEvent,
} from '@pc/contracts';
import type { DbExecutor, InsertLiveEventDraft, LiveOutboxEvent, WorkflowRunV2Record } from '@pc/db';

function makeRow(over: Partial<WorkflowRunV2Record> = {}): WorkflowRunV2Record {
  return {
    id: 'r1',
    workflowId: 'deploy',
    workflowName: 'Deploy',
    projectId: 'p1',
    workItemId: 'wi1',
    trigger: 'manual',
    stageId: null,
    triggeredBySessionId: null,
    status: 'running',
    workflowYamlSnapshot: JSON.stringify({ id: 'deploy', name: 'Deploy', triggers: [], nodes: [] }),
    worktreePath: null,
    dagState: { nodes: {} },
    triggerContext: {},
    metadata: {},
    lastReason: null,
    rev: 3,
    createdAt: 1,
    startedAt: 2,
    endedAt: null,
    lastActivityAt: 2,
    ...over,
  };
}

function makeGateway(row: WorkflowRunV2Record | null = makeRow()): {
  gateway: WorkflowRunMutationGateway;
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
  }) as WorkflowRunGatewayDeps['insertLiveEvent'];

  const deps: WorkflowRunGatewayDeps = {
    transaction: (fn) => fn({} as DbExecutor),
    insertLiveEvent: fakeInsert,
    getRun: () => row,
  };
  return { gateway: new WorkflowRunMutationGateway(deps), inserted };
}

test('commitRunChange emits exactly one canonical workflow.run.changed with rev as version', () => {
  const { gateway, inserted } = makeGateway();
  const pub = gateway.commitRunChange({
    projectId: 'p1',
    reason: 'fired',
    mutate: () => makeRow({ rev: 4 }),
  });
  assert.equal(inserted.length, 1);
  assert.equal(isWorkflowRunChangedLiveEvent(pub.liveEvent), true);
  assert.equal(pub.liveEvent.type, 'workflow.run.changed');
  assert.equal(pub.liveEvent.version, 4);
  assert.equal(pub.run.rev, 4);
  assert.equal(pub.liveEvent.payload.reason, 'fired');
});

test('definitionHash is surfaced on the run DTO and is snapshot-derived', () => {
  const snapshot = JSON.stringify({ id: 'deploy', name: 'Deploy', triggers: [], nodes: [{ id: 'a', kind: 'agent', agent: 'writer', task: 'go' }] });
  const { gateway } = makeGateway(makeRow({ workflowYamlSnapshot: snapshot }));
  const pub = gateway.commitRunChange({ projectId: 'p1', reason: 'advanced', mutate: () => makeRow({ workflowYamlSnapshot: snapshot }) });
  assert.equal(typeof pub.run.definitionHash, 'string');
  assert.equal(pub.run.definitionHash.length, 64); // sha256 hex
  // A different snapshot yields a different hash (version-pinning fingerprint).
  const { gateway: g2 } = makeGateway(makeRow());
  const pub2 = g2.commitRunChange({ projectId: 'p1', reason: 'advanced', mutate: () => makeRow() });
  assert.notEqual(pub.run.definitionHash, pub2.run.definitionHash);
});

test('a mutation that throws emits NOTHING (rollback semantics)', () => {
  const { gateway, inserted } = makeGateway();
  assert.throws(() =>
    gateway.commitRunChange({
      projectId: 'p1',
      reason: 'advanced',
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
    gateway.commitRunChange({ projectId: 'p1', reason: 'advanced', mutate: () => null }),
  );
  assert.equal(inserted.length, 0);
});

test('cancelRun cancels a non-terminal run and is a no-op on terminal runs', () => {
  let stored = makeRow({ status: 'running', rev: 3 });
  const inserted: InsertLiveEventDraft[] = [];
  const deps: WorkflowRunGatewayDeps = {
    transaction: (fn) => fn({} as DbExecutor),
    insertLiveEvent: (<TPayload>(_db: DbExecutor, draft: InsertLiveEventDraft<TPayload>) => {
      inserted.push(draft as InsertLiveEventDraft);
      return {
        id: 'e', cursor: '1', scope: draft.scope, projectId: draft.projectId, type: draft.type,
        entity: draft.entity, entityId: draft.entityId, version: draft.version, createdAt: 1, payload: draft.payload,
      } as LiveOutboxEvent<TPayload>;
    }) as WorkflowRunGatewayDeps['insertLiveEvent'],
    getRun: () => stored,
  };
  const gateway = new WorkflowRunMutationGateway(deps);

  const pub = gateway.cancelRun({ projectId: 'p1', runId: 'r1' });
  assert.notEqual(pub, null);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]!.payload && (inserted[0]!.payload as { reason: string }).reason, 'cancelled');

  // Now terminal — cancel is a no-op, emits nothing further.
  stored = makeRow({ status: 'completed' });
  const again = gateway.cancelRun({ projectId: 'p1', runId: 'r1' });
  assert.equal(again, null);
  assert.equal(inserted.length, 1);
});

test('commitReviewChange emits a canonical workflow.review.changed fact', () => {
  for (const state of ['pending', 'approved', 'rejected'] as const) {
    const { gateway, inserted } = makeGateway();
    const pub = gateway.commitReviewChange({
      projectId: 'p1',
      runId: 'r1',
      nodeId: 'n1',
      flavor: 'human',
      state,
    });
    assert.equal(inserted.length, 1);
    assert.equal(isWorkflowReviewChangedLiveEvent(pub.liveEvent), true);
    assert.equal(pub.liveEvent.payload.state, state);
  }
});
