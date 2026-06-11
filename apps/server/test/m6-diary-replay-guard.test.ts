// M6 slice D — FD-13 GUARD: the run diary is provably the truth. Drives the
// REAL executor (fake deps) through a reject-loop story while capturing its
// diary event stream, then replays the diary through the pure transitions and
// asserts the derived node states ≡ the executor's final dagState. If a state
// transition ever ships without its diary line, this breaks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ULID, WorkflowV2 } from '@pc/domain';
import { deriveDagStateFromDiary, type ReplayDiaryEvent } from '@pc/workflows';
import { DagExecutor, type DagExecutorDeps, type NodeOutcome } from '../src/services/dag-executor.ts';

const ctxBase = { runId: 'run-1' as ULID, rootWorkItemId: 'wi-1' as ULID, worktreePath: null };

function statesOf(state: WorkflowV2.WorkflowDagState): Record<string, string> {
  return Object.fromEntries(Object.entries(state.nodes).map(([id, rec]) => [id, rec.state]));
}

test('FD-13 guard: replaying the diary reproduces the executor node states (reject-loop story)', async () => {
  const diary: ReplayDiaryEvent[] = [];
  let dispatched = 0;
  const deps: DagExecutorDeps = {
    resolveRef: () => () => '',
    dispatchAgent: async (): Promise<NodeOutcome> => {
      dispatched += 1;
      return { state: 'completed', workItemId: `wi-${dispatched}` as ULID };
    },
    moveCard: async () => ({ ok: true }),
    mergeToIntegration: async () => ({ outcome: 'merged' as const }),
    requestReview: async () => {},
    persist: () => {},
    event: (ev) => diary.push({ type: ev.type, nodeId: ev.nodeId ?? null, data: ev.data ?? null }),
    isCancelled: () => false,
  };
  const wf: WorkflowV2.Workflow = {
    id: 'wf',
    name: 'WF',
    nodes: [
      { id: 'build', kind: 'agent', agent: 'x', task: 'build', next: ['to-review'] },
      { id: 'to-review', kind: 'move', stage: 'review-col', next: ['gate'] },
      { id: 'gate', kind: 'review', reviewer: 'orchestrator', next: ['ship'], reject: 'gate-loop' },
      { id: 'gate-loop', kind: 'loop', back_to: 'build', max_iterations: 3 },
      { id: 'ship', kind: 'move', stage: 'done-col' },
    ],
  };

  const exec = DagExecutor.start(wf, deps, ctxBase);
  await exec.advance(); // build → move → gate (awaiting)
  await exec.onReviewDecision('gate', { kind: 'reject', notes: 'again' }); // loop → re-run → gate
  await exec.onReviewDecision('gate', { kind: 'approve' }); // ship → completed

  const replayed = deriveDagStateFromDiary(wf, diary);
  assert.deepEqual(
    statesOf(replayed),
    statesOf(exec.getState()),
    'diary replay must reproduce every node state — a transition shipped without its diary line',
  );
  // The loop's iteration bookkeeping is derivable too.
  assert.deepEqual(replayed.rejectIterations, exec.getState().rejectIterations);
});

test('FD-13 guard: ceiling escalation + held-gate approve replay to the same states', async () => {
  const diary: ReplayDiaryEvent[] = [];
  const deps: DagExecutorDeps = {
    resolveRef: () => () => '',
    dispatchAgent: async (): Promise<NodeOutcome> => ({ state: 'completed' }),
    moveCard: async () => ({ ok: true }),
    mergeToIntegration: async () => ({ outcome: 'merged' as const }),
    requestReview: async () => {},
    persist: () => {},
    event: (ev) => diary.push({ type: ev.type, nodeId: ev.nodeId ?? null, data: ev.data ?? null }),
    isCancelled: () => false,
  };
  const wf: WorkflowV2.Workflow = {
    id: 'wf',
    name: 'WF',
    nodes: [
      { id: 'build', kind: 'agent', agent: 'x', task: 'build', next: ['gate'] },
      { id: 'gate', kind: 'review', reviewer: 'orchestrator', reject: 'gate-loop' },
      { id: 'gate-loop', kind: 'loop', back_to: 'build', max_iterations: 1 },
    ],
  };

  const exec = DagExecutor.start(wf, deps, ctxBase);
  await exec.advance();
  await exec.onReviewDecision('gate', { kind: 'reject', notes: 'no' }); // ceiling → escalated pause
  await exec.onReviewDecision('gate', { kind: 'approve' }); // human accepts → completed

  const replayed = deriveDagStateFromDiary(wf, diary);
  assert.deepEqual(statesOf(replayed), statesOf(exec.getState()));
});
