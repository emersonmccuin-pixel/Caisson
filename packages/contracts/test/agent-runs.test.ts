import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveEventFrame,
  buildAgentRunChangedRefetchEnvelope,
  isAgentRunChangedLiveEvent,
  isAgentRunChangedLiveEventFrame,
  isAgentRunChangedLivePayload,
  isAgentRunDto,
  isPendingAskDto,
  parseAnswerPendingAskRequest,
  parseCreatePendingAskRequest,
  toLegacyAgentRunChanged,
  toLegacyAgentRunRecord,
  type AgentRunChangedLiveEvent,
  type AgentRunDto,
} from '../src/index.ts';

function makeDto(over: Partial<AgentRunDto> = {}): AgentRunDto {
  return {
    runId: 'run1',
    sessionId: 'cc-1',
    agentName: 'builder',
    model: 'opus',
    projectId: 'p1',
    parentWorkItemId: null,
    dispatcherSessionId: 'disp1',
    worktreeDir: '/tmp/wt',
    startedAt: 100,
    status: 'running',
    result: '',
    failureReason: null,
    failureCause: null,
    endedAt: null,
    rev: 3,
    ...over,
  };
}

function makeEvent(over: Partial<AgentRunChangedLiveEvent> = {}): AgentRunChangedLiveEvent {
  return {
    id: 'evt1',
    cursor: '5',
    scope: 'project',
    projectId: 'p1',
    type: 'agent.run.changed',
    entity: 'agent-run',
    entityId: 'run1',
    version: 3,
    createdAt: 1000,
    payload: { reason: 'running', run: makeDto() },
    ...over,
  } as AgentRunChangedLiveEvent;
}

test('isAgentRunDto accepts a full DTO and rejects malformed', () => {
  assert.equal(isAgentRunDto(makeDto()), true);
  assert.equal(isAgentRunDto({ ...makeDto(), status: 'bogus' }), false);
  assert.equal(isAgentRunDto({ ...makeDto(), rev: 'x' }), false);
  assert.equal(isAgentRunDto(null), false);
});

test('isPendingAskDto accepts a full DTO and rejects bad kind/status', () => {
  const ask = {
    id: 'a1',
    agentRunId: 'run1',
    ccSessionId: 'cc-1',
    projectId: 'p1',
    parentWorkItemId: null,
    kind: 'orchestrator',
    promptBody: 'q?',
    context: null,
    options: [{ label: 'Yes', value: 'y' }],
    status: 'open',
    answeredBy: null,
    createdAt: 1,
    answeredAt: null,
    cancelledAt: null,
  };
  assert.equal(isPendingAskDto(ask), true);
  assert.equal(isPendingAskDto({ ...ask, kind: 'nope' }), false);
  assert.equal(isPendingAskDto({ ...ask, status: 'waiting' }), false);
});

test('canonical agent.run.changed payload guard validates reason + run', () => {
  assert.equal(isAgentRunChangedLivePayload({ reason: 'paused', run: makeDto() }), true);
  assert.equal(
    isAgentRunChangedLivePayload({ reason: 'paused', run: makeDto(), pendingAskId: 'a1' }),
    true,
  );
  assert.equal(isAgentRunChangedLivePayload({ reason: 'bogus', run: makeDto() }), false);
  assert.equal(isAgentRunChangedLivePayload({ reason: 'paused' }), false);
});

test('isAgentRunChangedLiveEvent requires project scope + agent-run entity', () => {
  assert.equal(isAgentRunChangedLiveEvent(makeEvent()), true);
  assert.equal(isAgentRunChangedLiveEvent(makeEvent({ entity: 'project' as never })), false);
  assert.equal(
    isAgentRunChangedLiveEvent(makeEvent({ scope: 'global' as never, projectId: null as never })),
    false,
  );
  assert.equal(isAgentRunChangedLiveEvent(makeEvent({ type: 'x' as never })), false);
});

test('frame guard accepts a wrapped canonical event', () => {
  const frame = buildLiveEventFrame(makeEvent());
  assert.equal(isAgentRunChangedLiveEventFrame(frame), true);
  assert.equal(isAgentRunChangedLiveEventFrame({ type: 'live-event', event: {} }), false);
});

test('legacy agent-run-changed adapter round-trips the v1 record incl. model + wait:false', () => {
  const dto = makeDto({ status: 'completed', result: 'done', rev: 9 });
  const env = buildAgentRunChangedRefetchEnvelope(dto);
  assert.equal(env.type, 'agent-run-changed');
  assert.equal(env.record.wait, false);
  assert.equal(env.record.model, 'opus');
  assert.equal(env.record.runId, 'run1');
  assert.equal(env.record.status, 'completed');
  assert.equal(env.record.result, 'done');
  assert.equal(env.record.rev, 9);

  const fromEvent = toLegacyAgentRunChanged(makeEvent({ payload: { reason: 'running', run: dto } }));
  assert.deepEqual(fromEvent.record, toLegacyAgentRunRecord(dto));
});

test('parseCreatePendingAskRequest requires options for approval kind', () => {
  assert.equal(
    parseCreatePendingAskRequest({ agentRunId: 'r1', kind: 'approval', promptBody: 'ok?' }).ok,
    false,
  );
  const ok = parseCreatePendingAskRequest({
    agentRunId: 'r1',
    kind: 'approval',
    promptBody: 'ok?',
    options: [{ label: 'Yes', value: 'y' }],
  });
  assert.equal(ok.ok, true);
  assert.equal(parseCreatePendingAskRequest({ agentRunId: 'r1', kind: 'orchestrator', promptBody: 'q' }).ok, true);
  assert.equal(parseCreatePendingAskRequest({ kind: 'orchestrator', promptBody: 'q' }).ok, false);
});

test('parseAnswerPendingAskRequest enforces answer + answeredBy enum', () => {
  assert.equal(parseAnswerPendingAskRequest({ answer: 'a' }).ok, false);
  assert.equal(parseAnswerPendingAskRequest({ answer: 'a', answeredBy: 'bot' }).ok, false);
  assert.equal(parseAnswerPendingAskRequest({ answer: 'a', answeredBy: 'user' }).ok, true);
});
