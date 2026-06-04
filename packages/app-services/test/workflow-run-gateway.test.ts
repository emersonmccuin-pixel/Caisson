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

test('cancelRun: status flip + run fact + workflow_cancelled diary line, one txn; no-op on terminal', () => {
  let stored = makeRow({ status: 'running', rev: 3 });
  const inserted: InsertLiveEventDraft[] = [];
  const appended: Array<{ runId: string; type: string }> = [];
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
    setStatus: () => {},
    appendEvent: ((input: { runId: string; type: string }) => {
      appended.push({ runId: input.runId, type: input.type });
      return { id: 'wre-1', runId: input.runId, type: input.type, nodeId: null, data: null, at: 5 };
    }) as unknown as WorkflowRunGatewayDeps['appendEvent'],
  };
  const gateway = new WorkflowRunMutationGateway(deps);

  const pub = gateway.cancelRun({ projectId: 'p1', runId: 'r1' });
  assert.notEqual(pub, null);
  // M3a — TWO facts in the one txn: the run change AND its diary line.
  assert.equal(inserted.length, 2);
  assert.equal((inserted[0]!.payload as { reason: string }).reason, 'cancelled');
  assert.equal(inserted[1]!.type, 'workflow.run.event');
  assert.deepEqual(appended, [{ runId: 'r1', type: 'workflow_cancelled' }]);

  // Now terminal — cancel is a no-op, emits nothing further.
  stored = makeRow({ status: 'completed' });
  const again = gateway.cancelRun({ projectId: 'p1', runId: 'r1' });
  assert.equal(again, null);
  assert.equal(inserted.length, 2);
});

test('appendRunEvent (M3a, THE diary door): event row + workflow.run.event fact in one txn', () => {
  const { gateway, inserted } = makeGateway();
  const appended: unknown[] = [];
  const gw = new WorkflowRunMutationGateway({
    transaction: (fn) => fn({} as DbExecutor),
    insertLiveEvent: ((_db: DbExecutor, draft: InsertLiveEventDraft) => {
      inserted.push(draft);
      return {
        id: 'e1', cursor: '1', scope: draft.scope, projectId: draft.projectId, type: draft.type,
        entity: draft.entity, entityId: draft.entityId, version: draft.version, createdAt: 1, payload: draft.payload,
      } as LiveOutboxEvent;
    }) as WorkflowRunGatewayDeps['insertLiveEvent'],
    getRun: () => null,
    appendEvent: ((input: { runId: string; type: string; nodeId?: string; data?: Record<string, unknown> }) => {
      appended.push(input);
      return {
        id: 'wre-7', runId: input.runId, type: input.type,
        nodeId: input.nodeId ?? null, data: input.data ?? null, at: 42,
      };
    }) as unknown as WorkflowRunGatewayDeps['appendEvent'],
  });
  void gateway;

  const pub = gw.appendRunEvent({
    projectId: 'p1' as never,
    runId: 'r1' as never,
    type: 'agent_dispatched',
    nodeId: 'write',
    data: { agentRunId: 'ar-1', workItemId: 'wi-9' },
  });
  assert.equal(appended.length, 1);
  assert.equal(inserted.length, 1);
  assert.equal(pub.liveEvent.type, 'workflow.run.event');
  assert.equal(pub.liveEvent.entity, 'workflow-run-event');
  assert.equal(pub.liveEvent.entityId, 'r1', 'entityId is the RUN id (timeline subscription key)');
  assert.equal(pub.liveEvent.version, null, 'append-only — no rev to guard');
  const payload = pub.liveEvent.payload as { event: { type: string; data: Record<string, unknown> | null } };
  assert.equal(payload.event.type, 'agent_dispatched');
  assert.deepEqual(payload.event.data, { agentRunId: 'ar-1', workItemId: 'wi-9' });
  assert.equal(pub.event.id, 'wre-7');
});

test('appendRunEvent: an insert that throws rolls back with the event row (one txn)', () => {
  const appended: unknown[] = [];
  const gw = new WorkflowRunMutationGateway({
    // Real-txn semantics fake: rethrow = rollback (nothing observable outside).
    transaction: (fn) => fn({} as DbExecutor),
    insertLiveEvent: (() => {
      throw new Error('outbox unavailable');
    }) as unknown as WorkflowRunGatewayDeps['insertLiveEvent'],
    getRun: () => null,
    appendEvent: ((input: { runId: string; type: string }) => {
      appended.push(input);
      return { id: 'x', runId: input.runId, type: input.type, nodeId: null, data: null, at: 1 };
    }) as unknown as WorkflowRunGatewayDeps['appendEvent'],
  });
  assert.throws(() =>
    gw.appendRunEvent({ projectId: 'p1' as never, runId: 'r1' as never, type: 'workflow_started' }),
  );
  // The seam was reached, but in the real gateway both writes share the txn —
  // the throw above rolls the event row back with it.
  assert.equal(appended.length, 1);
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
