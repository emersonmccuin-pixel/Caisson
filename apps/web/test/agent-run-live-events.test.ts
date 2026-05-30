import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  agentRunChangedLiveEventFromUnknown,
  scanAgentRunLiveEvents,
  shouldAcceptAgentRunWsEnvelope,
} from '../src/features/agent-runs/live-events.ts';
import type { AgentRunDto } from '@pc/contracts';

function run(over: Partial<AgentRunDto> = {}): AgentRunDto {
  return {
    runId: 'r1',
    sessionId: 'cc-1',
    agentName: 'builder',
    model: 'opus',
    projectId: 'p1',
    parentWorkItemId: null,
    dispatcherSessionId: 'disp1',
    worktreeDir: '/wt',
    startedAt: 1,
    status: 'running',
    result: '',
    failureReason: null,
    failureCause: null,
    endedAt: null,
    rev: 1,
    ...over,
  };
}

function frame(id: string, cursor: string, r: AgentRunDto, reason = 'running') {
  return {
    type: 'live-event',
    event: {
      id,
      cursor,
      scope: 'project',
      projectId: 'p1',
      type: 'agent.run.changed',
      entity: 'agent-run',
      entityId: r.runId,
      version: r.rev,
      createdAt: 1,
      payload: { reason, run: r },
    },
  };
}

test('accepts a canonical agent.run.changed frame and rejects unrelated frames', () => {
  assert.equal(shouldAcceptAgentRunWsEnvelope(frame('e1', '1', run()), 'p1'), true);
  assert.equal(shouldAcceptAgentRunWsEnvelope({ type: 'workflow.run.changed' }, 'p1'), false);
  // legacy project-scoped envelope still accepted by projectId tag.
  assert.equal(shouldAcceptAgentRunWsEnvelope({ projectId: 'p1' }, 'p1'), true);
  assert.equal(shouldAcceptAgentRunWsEnvelope({ projectId: 'other' }, 'p1'), false);
});

test('rev-aware upsert keeps the higher rev and drops out-of-order frames', () => {
  const events = [
    frame('e1', '1', run({ rev: 1 })),
    frame('e2', '2', run({ rev: 3 })),
    frame('e3', '3', run({ rev: 2 })), // stale — must not overwrite rev 3
  ];
  const result = scanAgentRunLiveEvents(events, 0);
  assert.equal(result.runs.get('r1')?.rev, 3);
  assert.equal(result.latestCursor, '3');
});

test('dedupes by event id', () => {
  const events = [frame('e1', '1', run({ rev: 2 })), frame('e1', '1', run({ rev: 5 }))];
  const result = scanAgentRunLiveEvents(events, 0);
  // second is a duplicate id -> ignored.
  assert.equal(result.runs.get('r1')?.rev, 2);
});

test('drops terminal runs from the active map', () => {
  const events = [
    frame('e1', '1', run({ rev: 1, status: 'running' })),
    frame('e2', '2', run({ rev: 2, status: 'completed' }), 'completed'),
  ];
  const result = scanAgentRunLiveEvents(events, 0);
  assert.equal(result.runs.has('r1'), false);
});

test('agentRunChangedLiveEventFromUnknown unwraps a frame or a bare event', () => {
  const f = frame('e1', '1', run());
  assert.equal(agentRunChangedLiveEventFromUnknown(f)?.id, 'e1');
  assert.equal(agentRunChangedLiveEventFromUnknown(f.event)?.id, 'e1');
  assert.equal(agentRunChangedLiveEventFromUnknown({ type: 'nope' }), null);
});
