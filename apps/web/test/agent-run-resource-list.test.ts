// Slice 015b — agent-runs resource-list rewire to the canonical relay frame.
//
// The active Activity-panel path is `useProjectAgentRuns` → `useResourceList`,
// now keyed on the generic `{type:'live-event', event}` frame (entity
// `agent-run`) the relay delivers — not the deleted legacy `agent-run-changed`
// envelope. The web test runner (`tsx --test` from repo root) cannot resolve the
// `@/` Vite alias, so the hook + reducer modules can't be imported directly;
// `pnpm typecheck` covers their wiring. These tests pin the two contract-level
// seams the rewire depends on, replicating production logic verbatim:
//   1. the live-event extractor (entity gate + project gate + DTO→record adapt)
//   2. the reducer admission predicate (keep this project's / global frames;
//      reject another project's rows) — the exact boolean added to applyEnvelope.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAgentRunChangedLivePayload,
  isLiveEventFrame,
  type AgentRunDto,
  type LiveEvent,
} from '@pc/contracts';

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

function frame(r: AgentRunDto, projectId: string | null = 'p1', reason = 'running'): unknown {
  return {
    type: 'live-event',
    event: {
      id: `e-${r.runId}-${r.rev}`,
      cursor: String(r.rev),
      scope: projectId === null ? 'global' : 'project',
      projectId,
      type: 'agent.run.changed',
      entity: 'agent-run',
      entityId: r.runId,
      version: r.rev,
      createdAt: 1,
      payload: { reason, run: r },
    },
  };
}

// Verbatim copy of useProjectAgentRuns' extractFromLiveEvent (entity matched by
// the hook's `liveEventEntity:'agent-run'` filter before this runs).
function extractFromLiveEvent(event: LiveEvent, projectId: string): AgentRunDto & { wait: false } | null {
  if (!isAgentRunChangedLivePayload(event.payload)) return null;
  const r = event.payload.run;
  if (r.projectId !== projectId) return null;
  return { ...r, wait: false };
}

// Verbatim copy of the predicate added to chat-session-reducer's applyEnvelope.
function reducerKeepsFrame(env: unknown, statePid: string): boolean {
  return (
    isLiveEventFrame(env) &&
    (env.event.projectId === null || env.event.projectId === statePid)
  );
}

test('extractor adapts an agent-run frame to the legacy record (wait:false)', () => {
  const f = frame(run({ rev: 4 })) as { event: LiveEvent };
  const rec = extractFromLiveEvent(f.event, 'p1');
  assert.ok(rec);
  assert.equal(rec?.runId, 'r1');
  assert.equal(rec?.rev, 4);
  assert.equal(rec?.wait, false);
});

test('extractor rejects a run snapshot for a different project', () => {
  const f = frame(run({ projectId: 'other' }), 'other') as { event: LiveEvent };
  assert.equal(extractFromLiveEvent(f.event, 'p1'), null);
});

test('reducer predicate keeps this project and global frames, rejects other projects', () => {
  assert.equal(reducerKeepsFrame(frame(run()), 'p1'), true);
  assert.equal(reducerKeepsFrame(frame(run(), null), 'p1'), true);
  assert.equal(reducerKeepsFrame(frame(run(), 'other'), 'p1'), false);
  // non-frame envelopes are not matched by this predicate (the other guards apply).
  assert.equal(reducerKeepsFrame({ type: 'agent-run-changed', projectId: 'p1' }, 'p1'), false);
});
