// Workflow-engine redesign (slice 7) — a failed run notifies the human inbox +
// the project orchestrator. This pins the EXECUTOR hook: when a run finalizes
// `failed`, the executor fires `notifyRunFailed(reason)` exactly once, carrying
// the derived failure reason. The two-recipient mailbox fan-out
// (deliverWorkflowRunFailed in index.ts) rides this hook and is typechecked at
// its call site; the end-to-end inbox delivery is covered by the e2e re-fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ULID, WorkflowV2 } from '@pc/domain';
import { DagExecutor, type DagExecutorDeps, type NodeOutcome } from '../src/services/dag-executor.ts';

function baseDeps(over: Partial<DagExecutorDeps> = {}): DagExecutorDeps {
  return {
    resolveRef: () => () => '',
    dispatchAgent: async (): Promise<NodeOutcome> => ({ state: 'completed' }),
    moveCard: async () => ({ ok: true }),
    requestReview: async () => {},
    persist: () => {},
    event: () => {},
    isCancelled: () => false,
    holdForHuman: () => {},
    ...over,
  };
}

const ctxBase = { runId: 'run-1' as ULID, rootWorkItemId: 'wi-1' as ULID, worktreePath: null };

function oneAgentWorkflow(): WorkflowV2.Workflow {
  return {
    id: 'wf',
    name: 'Test Flow',
    triggers: [],
    nodes: [{ id: 'a', kind: 'agent', agent: 'writer', task: 'do it' }],
  };
}

test('a failed run fires notifyRunFailed once with the derived reason', async () => {
  const calls: string[] = [];
  const deps = baseDeps({
    dispatchAgent: async () => ({ state: 'failed', error: 'boom' }),
    notifyRunFailed: (reason) => calls.push(reason),
  });

  const exec = DagExecutor.start(oneAgentWorkflow(), deps, ctxBase);
  const status = await exec.advance();

  assert.equal(status, 'failed');
  assert.equal(calls.length, 1, 'notifyRunFailed fires exactly once');
  assert.match(calls[0]!, /boom/, 'carries the failing node reason');
});

test('a step with `move` advances the card on completion (card-move effect)', async () => {
  const moves: string[] = [];
  const deps = baseDeps({
    dispatchAgent: async () => ({ state: 'completed' }),
    moveCard: async (stage) => (moves.push(stage), { ok: true }),
  });
  const exec = DagExecutor.start(
    {
      id: 'wf',
      name: 'WF',
      triggers: [],
      nodes: [{ id: 'a', kind: 'agent', agent: 'x', task: 'go', move: 'review' }],
    },
    deps,
    ctxBase,
  );
  await exec.advance();
  assert.deepEqual(moves, ['review'], 'the card moves to the step\'s `move` stage');
});

test('a failed step does NOT move the card', async () => {
  const moves: string[] = [];
  const deps = baseDeps({
    dispatchAgent: async () => ({ state: 'failed', error: 'x' }),
    moveCard: async (stage) => (moves.push(stage), { ok: true }),
  });
  const exec = DagExecutor.start(
    {
      id: 'wf',
      name: 'WF',
      triggers: [],
      nodes: [{ id: 'a', kind: 'agent', agent: 'x', task: 'go', move: 'review' }],
    },
    deps,
    ctxBase,
  );
  await exec.advance();
  assert.deepEqual(moves, [], 'no move on a failed step');
});

test('reject notes auto-flow to the kicked-back node as $carry.feedback', async () => {
  const carries: Record<string, string>[] = [];
  let dispatched = 0;
  const deps = baseDeps({
    dispatchAgent: async (_node, ctx): Promise<NodeOutcome> => {
      dispatched += 1;
      carries.push({ ...ctx.carry });
      return { state: 'completed', workItemId: `wi-${dispatched}` as ULID };
    },
  });
  const wf: WorkflowV2.Workflow = {
    id: 'wf',
    name: 'WF',
    triggers: [],
    nodes: [
      { id: 'build', kind: 'agent', agent: 'x', task: 'build it' },
      { id: 'gate', kind: 'review', reviewer: 'human', reject: { back_to: 'build', max_iterations: 3 } },
    ],
  };
  const exec = DagExecutor.start(wf, deps, ctxBase);
  const s1 = await exec.advance();
  assert.equal(s1, 'awaiting-review');
  assert.deepEqual(carries[0], {}, 'first build run has no reviewer feedback');

  const s2 = await exec.onReviewDecision('gate', { kind: 'reject', notes: 'make it punchier' });
  assert.equal(s2, 'awaiting-review', 're-runs build then re-pauses at the gate');
  assert.equal(dispatched, 2, 'build re-dispatched once after the reject');
  assert.equal(
    carries[1]?.feedback,
    'make it punchier',
    'reject notes auto-flow as $carry.feedback with no manual wiring',
  );
});

test('an explicit reject.carry.feedback overrides the auto-seeded notes', async () => {
  const carries: Record<string, string>[] = [];
  let dispatched = 0;
  const deps = baseDeps({
    dispatchAgent: async (_node, ctx): Promise<NodeOutcome> => {
      dispatched += 1;
      carries.push({ ...ctx.carry });
      return { state: 'completed', workItemId: `wi-${dispatched}` as ULID };
    },
  });
  const wf: WorkflowV2.Workflow = {
    id: 'wf',
    name: 'WF',
    triggers: [],
    nodes: [
      { id: 'build', kind: 'agent', agent: 'x', task: 'build it' },
      {
        id: 'gate',
        kind: 'review',
        reviewer: 'human',
        reject: { back_to: 'build', max_iterations: 3, carry: { feedback: 'CUSTOM' } },
      },
    ],
  };
  const exec = DagExecutor.start(wf, deps, ctxBase);
  await exec.advance();
  await exec.onReviewDecision('gate', { kind: 'reject', notes: 'ignored by override' });
  assert.equal(carries[1]?.feedback, 'CUSTOM', 'explicit reject.carry wins over the default');
});

test('a completed run does NOT fire notifyRunFailed', async () => {
  const calls: string[] = [];
  const deps = baseDeps({
    dispatchAgent: async () => ({ state: 'completed' }),
    notifyRunFailed: (reason) => calls.push(reason),
  });

  const exec = DagExecutor.start(oneAgentWorkflow(), deps, ctxBase);
  const status = await exec.advance();

  assert.equal(status, 'completed');
  assert.equal(calls.length, 0, 'no failure notice on a successful run');
});
