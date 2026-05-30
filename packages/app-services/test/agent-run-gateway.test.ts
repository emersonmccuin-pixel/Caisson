import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunMutationGateway,
  toAgentRunDto,
  type AgentRunGatewayDeps,
} from '../src/agent-runs/index.ts';
import { isAgentRunChangedLiveEvent } from '@pc/contracts';
import type { DbExecutor, InsertLiveEventDraft, LiveOutboxEvent } from '@pc/db';
import type { AgentRunRow } from '@pc/domain';

function makeRow(over: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: 'run1' as AgentRunRow['id'],
    projectId: 'p1' as AgentRunRow['projectId'],
    dispatcherSessionId: 'disp1',
    ccSessionId: 'cc-uuid-1',
    podName: 'builder',
    podRevisionAtDispatch: 'rev-a',
    podRevisionAtResume: null,
    status: 'running',
    continues: null,
    parentInvokeDepth: 1,
    parentWorkItemId: null,
    input: 'go',
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: 100,
    spawnedAt: 110,
    readyAt: 120,
    pid: 4242,
    lastActivityAt: 130,
    completedAt: null,
    rev: 3,
    ...over,
  };
}

interface Harness {
  gateway: AgentRunMutationGateway;
  inserted: InsertLiveEventDraft[];
  calls: string[];
}

function makeGateway(opts: {
  row?: AgentRunRow | null;
  rowAfter?: AgentRunRow | null;
  flip?: boolean;
  failTx?: boolean;
} = {}): Harness {
  const inserted: InsertLiveEventDraft[] = [];
  const calls: string[] = [];
  let seq = 0;
  let current = opts.row === undefined ? makeRow() : opts.row;

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
      createdAt: 1000 + seq,
      payload: draft.payload,
    };
  }) as AgentRunGatewayDeps['insertLiveEvent'];

  const deps: AgentRunGatewayDeps = {
    transaction: (fn) => {
      if (opts.failTx) throw new Error('forced tx failure');
      return fn({} as DbExecutor);
    },
    insertLiveEvent: fakeInsert,
    getRun: () => (opts.rowAfter !== undefined ? opts.rowAfter : current),
    updateStatus: (input) => {
      calls.push(`updateStatus:${input.status}`);
      if (current) current = { ...current, status: input.status, rev: current.rev + 1 };
    },
    markTerminal: (input) => {
      calls.push(`markTerminal:${input.status}`);
      if (current) {
        current = {
          ...current,
          status: input.status,
          rev: current.rev + 1,
          completedAt: input.completedAt,
          failureCause: input.failureCause,
          failureReason: input.failureReason,
        };
      }
    },
    createPendingAsk: (input) => {
      calls.push(`createPendingAsk:${input.id}`);
      return input;
    },
    markPendingAskAnswered: () => {
      calls.push('markAnswered');
      return opts.flip ?? true;
    },
    markPendingAskCancelled: () => {
      calls.push('markCancelled');
      return true;
    },
  };

  return { gateway: new AgentRunMutationGateway(deps), inserted, calls };
}

test('commitRunChange emits exactly one canonical agent.run.changed with rev as version', () => {
  const { gateway, inserted } = makeGateway();
  const pub = gateway.commitRunChange({
    reason: 'running',
    mutate: () => makeRow({ rev: 7 }),
  });
  assert.equal(inserted.length, 1);
  assert.equal(isAgentRunChangedLiveEvent(pub.liveEvent), true);
  assert.equal(pub.liveEvent.type, 'agent.run.changed');
  assert.equal(pub.liveEvent.entity, 'agent-run');
  assert.equal(pub.liveEvent.version, 7);
  assert.equal(pub.run.rev, 7);
  assert.equal(pub.liveEvent.payload.reason, 'running');
});

test('announceRunChange re-reads the post-write row for the correct (non-stale) rev', () => {
  // Simulate a write that bumped rev to 9; the gateway must read THAT, not a
  // pre-update value (closes handoff High issue #3 — host-mode stale rev).
  const { gateway } = makeGateway({ rowAfter: makeRow({ rev: 9, status: 'spawning' }) });
  const pub = gateway.announceRunChange({ runId: 'run1', reason: 'spawning' });
  assert.ok(pub);
  assert.equal(pub!.liveEvent.version, 9);
  assert.equal(pub!.run.rev, 9);
  assert.equal(pub!.run.status, 'spawning');
});

test('announceRunChange returns null (emits nothing) for an unknown run', () => {
  const { gateway, inserted } = makeGateway({ rowAfter: null });
  const pub = gateway.announceRunChange({ runId: 'gone', reason: 'running' });
  assert.equal(pub, null);
  assert.equal(inserted.length, 0);
});

test('a tx failure rolls back: the outbox insert never lands (no orphan row)', () => {
  const { gateway, inserted } = makeGateway({ failTx: true });
  assert.throws(() =>
    gateway.commitRunChange({ reason: 'running', mutate: () => makeRow() }),
  );
  assert.equal(inserted.length, 0);
});

test('pauseRun writes the ask + paused row + one paused fact with pendingAskId', () => {
  const { gateway, inserted, calls } = makeGateway({ row: makeRow({ status: 'running' }) });
  const pub = gateway.pauseRun({
    pendingAsk: {
      id: 'ask1' as never,
      agentRunId: 'run1' as never,
      ccSessionId: 'cc-uuid-1',
      projectId: 'p1' as never,
      kind: 'orchestrator',
      promptBody: 'q?',
      now: 200,
    },
  });
  assert.equal(inserted.length, 1);
  assert.equal(pub.liveEvent.payload.reason, 'paused');
  assert.equal(pub.liveEvent.payload.pendingAskId, 'ask1');
  assert.ok(calls.includes('createPendingAsk:ask1'));
  assert.ok(calls.includes('updateStatus:paused'));
});

test('answerAndResume: a no-op flip (replayed answer) emits nothing', () => {
  const { gateway, inserted, calls } = makeGateway({ flip: false });
  const pub = gateway.answerAndResume({
    pendingAskId: 'ask1' as never,
    agentRunId: 'run1' as never,
    answer: 'yes',
    answeredBy: 'orchestrator',
    now: 300,
    podRevisionAtResume: 'rev-b',
  });
  assert.equal(pub, null);
  assert.equal(inserted.length, 0);
  assert.ok(calls.includes('markAnswered'));
  // The spawning write must NOT happen when the flip was a no-op.
  assert.ok(!calls.includes('updateStatus:spawning'));
});

test('answerAndResume: a successful flip persists spawning + emits one resumed fact', () => {
  const { gateway, inserted, calls } = makeGateway({
    row: makeRow({ status: 'paused' }),
    rowAfter: makeRow({ status: 'spawning', rev: 4 }),
    flip: true,
  });
  const pub = gateway.answerAndResume({
    pendingAskId: 'ask1' as never,
    agentRunId: 'run1' as never,
    answer: 'yes',
    answeredBy: 'orchestrator',
    now: 300,
    podRevisionAtResume: 'rev-b',
  });
  assert.ok(pub);
  assert.equal(inserted.length, 1);
  assert.equal(pub!.liveEvent.payload.reason, 'resumed');
  assert.equal(pub!.liveEvent.version, 4);
  assert.ok(calls.includes('updateStatus:spawning'));
});

test('cancelRun finalizes a phantom paused run to cancelled + cancels the open ask', () => {
  // Start paused; markTerminal mutates `current` to cancelled so the post-write
  // re-read carries the terminal status + bumped rev.
  const { gateway, inserted, calls } = makeGateway({ row: makeRow({ status: 'paused', rev: 4 }) });
  const pub = gateway.cancelRun({ runId: 'run1', now: 400, cancelOpenAsk: 'ask1' as never });
  assert.ok(pub);
  assert.equal(inserted.length, 1);
  assert.equal(pub!.liveEvent.payload.reason, 'cancelled');
  assert.equal(pub!.run.status, 'cancelled');
  assert.equal(pub!.liveEvent.version, 5);
  assert.ok(calls.includes('markTerminal:cancelled'));
  assert.ok(calls.includes('markCancelled'));
});

test('cancelRun on an already-terminal run is a no-op (emits nothing)', () => {
  const { gateway, inserted } = makeGateway({ row: makeRow({ status: 'completed' }) });
  const pub = gateway.cancelRun({ runId: 'run1', now: 400 });
  assert.equal(pub, null);
  assert.equal(inserted.length, 0);
});

test('commitTerminal on an already-terminal run is idempotent (emits nothing)', () => {
  const { gateway, inserted } = makeGateway({ row: makeRow({ status: 'failed' }) });
  const pub = gateway.commitTerminal({
    runId: 'run1',
    status: 'failed',
    result: null,
    failureCause: 'unexpected-exit',
    failureReason: 'died',
    completedAt: 500,
  });
  assert.equal(pub, null);
  assert.equal(inserted.length, 0);
});

test('toAgentRunDto mirrors the v1 record (model opus, queuedAt as startedAt)', () => {
  const dto = toAgentRunDto(makeRow({ rev: 2 }));
  assert.equal(dto.model, 'opus');
  assert.equal(dto.startedAt, 100);
  assert.equal(dto.sessionId, 'cc-uuid-1');
  assert.equal(dto.rev, 2);
});
