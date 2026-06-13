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
    mergeToIntegration: async () => ({ outcome: 'merged' as const }),
    requestReview: async () => {},
    persist: () => {},
    event: () => {},
    isCancelled: () => false,
    ...over,
  };
}

const ctxBase = { runId: 'run-1' as ULID, rootWorkItemId: 'wi-1' as ULID, worktreePath: null };

function oneAgentWorkflow(): WorkflowV2.Workflow {
  return {
    id: 'wf',
    name: 'Test Flow',
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

test('a move STEP advances the card when it runs (FD-9 — a drawn step)', async () => {
  const moves: string[] = [];
  const deps = baseDeps({
    dispatchAgent: async () => ({ state: 'completed' }),
    moveCard: async (stage) => (moves.push(stage), { ok: true }),
  });
  const exec = DagExecutor.start(
    {
      id: 'wf',
      name: 'WF',
      nodes: [
        { id: 'a', kind: 'agent', agent: 'x', task: 'go', next: ['to-review'] },
        { id: 'to-review', kind: 'move', stage: 'review' },
      ],
    },
    deps,
    ctxBase,
  );
  const status = await exec.advance();
  assert.equal(status, 'completed');
  assert.deepEqual(moves, ['review'], 'the move step moves the card');
});

test('a failed move step fails honestly (and a failed upstream never reaches it)', async () => {
  const moves: string[] = [];
  const deps = baseDeps({
    dispatchAgent: async () => ({ state: 'failed', error: 'x' }),
    moveCard: async (stage) => (moves.push(stage), { ok: true }),
  });
  const exec = DagExecutor.start(
    {
      id: 'wf',
      name: 'WF',
      nodes: [
        { id: 'a', kind: 'agent', agent: 'x', task: 'go', next: ['to-review'] },
        { id: 'to-review', kind: 'move', stage: 'review' },
      ],
    },
    deps,
    ctxBase,
  );
  const status = await exec.advance();
  assert.equal(status, 'failed');
  assert.deepEqual(moves, [], 'a failed upstream skips the move step');

  // And a move whose card-move FAILS fails the step (it's a real step now).
  const deps2 = baseDeps({
    moveCard: async () => ({ ok: false, error: 'unknown stage' }),
  });
  const exec2 = DagExecutor.start(
    { id: 'wf2', name: 'WF2', nodes: [{ id: 'm', kind: 'move', stage: 'nope' }] },
    deps2,
    ctxBase,
  );
  const status2 = await exec2.advance();
  assert.equal(status2, 'failed', 'a failed card move fails the move step');
});

test('a move step on the approve path runs only after the gate approves', async () => {
  const moves: string[] = [];
  const deps = baseDeps({
    dispatchAgent: async (): Promise<NodeOutcome> => ({ state: 'completed', workItemId: 'wi-a' as ULID }),
    moveCard: async (stage) => (moves.push(stage), { ok: true }),
  });
  const wf: WorkflowV2.Workflow = {
    id: 'wf',
    name: 'WF',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'x', task: 'go', next: ['gate'] },
      { id: 'gate', kind: 'review', reviewer: 'human', next: ['ship'] },
      { id: 'ship', kind: 'move', stage: 'done' },
    ],
  };
  const exec = DagExecutor.start(wf, deps, ctxBase);
  const s1 = await exec.advance();
  assert.equal(s1, 'awaiting-review');
  assert.deepEqual(moves, [], 'no move until the gate is approved');
  const s2 = await exec.onReviewDecision('gate', { kind: 'approve' });
  assert.equal(s2, 'completed');
  assert.deepEqual(moves, ['done'], 'approving the gate runs the downstream move step');
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
    nodes: [
      { id: 'build', kind: 'agent', agent: 'x', task: 'build it' },
      { id: 'gate', kind: 'review', reviewer: 'human', reject: 'gate-loop' },
      { id: 'gate-loop', kind: 'loop', back_to: 'build', max_iterations: 3 },
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

test('an explicit loop carry.feedback overrides the auto-seeded notes', async () => {
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
    nodes: [
      { id: 'build', kind: 'agent', agent: 'x', task: 'build it' },
      { id: 'gate', kind: 'review', reviewer: 'human', reject: 'gate-loop' },
      {
        id: 'gate-loop',
        kind: 'loop',
        back_to: 'build',
        max_iterations: 3,
        carry: { feedback: 'CUSTOM' },
      },
    ],
  };
  const exec = DagExecutor.start(wf, deps, ctxBase);
  await exec.advance();
  await exec.onReviewDecision('gate', { kind: 'reject', notes: 'ignored by override' });
  assert.equal(carries[1]?.feedback, 'CUSTOM', 'explicit loop carry wins over the default');
});

test('loop ceiling PAUSES the run as an escalated HUMAN gate (FD-11 — never fails it)', async () => {
  const reviews: { reviewer: string; prompt: string }[] = [];
  const events: string[] = [];
  let dispatched = 0;
  const deps = baseDeps({
    dispatchAgent: async (): Promise<NodeOutcome> => {
      dispatched += 1;
      return { state: 'completed', workItemId: `wi-${dispatched}` as ULID };
    },
    requestReview: async (node) => {
      reviews.push({ reviewer: node.reviewer, prompt: node.prompt ?? '' });
    },
    event: (ev) => events.push(ev.type),
    notifyRunFailed: () => {
      throw new Error('ceiling must PAUSE, not fail');
    },
  });
  const wf: WorkflowV2.Workflow = {
    id: 'wf',
    name: 'WF',
    nodes: [
      { id: 'build', kind: 'agent', agent: 'x', task: 'build it' },
      { id: 'gate', kind: 'review', reviewer: 'orchestrator', reject: 'gate-loop' },
      { id: 'gate-loop', kind: 'loop', back_to: 'build', max_iterations: 2 },
    ],
  };
  const exec = DagExecutor.start(wf, deps, ctxBase);
  await exec.advance();
  const s1 = await exec.onReviewDecision('gate', { kind: 'reject', notes: 'no' }); // iter 1 → re-runs
  assert.equal(s1, 'awaiting-review');
  assert.equal(dispatched, 2);
  const s2 = await exec.onReviewDecision('gate', { kind: 'reject', notes: 'still no' }); // iter 2 = ceiling
  assert.equal(s2, 'awaiting-review', 'ceiling PAUSES the run — it does not fail');
  assert.equal(dispatched, 2, 'no re-run at the ceiling — the gate waits for a human');
  assert.ok(events.includes('iteration_ceiling_hit'));
  const last = reviews[reviews.length - 1]!;
  assert.equal(last.reviewer, 'human', 'the ceiling gate is escalated to a HUMAN');
  assert.match(last.prompt, /LOOP CEILING REACHED/);
  // The human can still approve the held gate and the run completes.
  const s3 = await exec.onReviewDecision('gate', { kind: 'approve' });
  assert.equal(s3, 'completed');
});

test('a cancel landing mid-layer finalizes CANCELLED — never failed (live-caught race)', async () => {
  // Simulates the real race: the cancel route cancels the run + its child
  // agent runs WHILE the executor awaits the layer; the child resolves failed.
  let cancelled = false;
  const persisted: string[] = [];
  const events: string[] = [];
  const deps = baseDeps({
    dispatchAgent: async (): Promise<NodeOutcome> => {
      cancelled = true; // the cancel lands while the dispatch is in flight
      return { state: 'failed', error: 'agent run cancelled' };
    },
    isCancelled: () => cancelled,
    persist: (_s, status) => persisted.push(status),
    event: (ev) => events.push(ev.type),
    notifyRunFailed: () => {
      throw new Error('a cancelled run must not fire the failure notice');
    },
  });
  const exec = DagExecutor.start(oneAgentWorkflow(), deps, ctxBase);
  const status = await exec.advance();
  assert.equal(status, 'cancelled');
  assert.equal(persisted[persisted.length - 1], 'cancelled');
  assert.ok(!events.includes('workflow_failed'), 'no bogus workflow_failed diary line');
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

test('a completed run fires notifyRunCompleted once (first-run nudge hook)', async () => {
  let completed = 0;
  const failed: string[] = [];
  const deps = baseDeps({
    dispatchAgent: async () => ({ state: 'completed' }),
    notifyRunCompleted: () => {
      completed += 1;
    },
    notifyRunFailed: (reason) => failed.push(reason),
  });

  const exec = DagExecutor.start(oneAgentWorkflow(), deps, ctxBase);
  const status = await exec.advance();

  assert.equal(status, 'completed');
  assert.equal(completed, 1, 'notifyRunCompleted fires exactly once on a completed run');
  assert.equal(failed.length, 0, 'no failure notice on a successful run');
});

test('a failed run does NOT fire notifyRunCompleted', async () => {
  let completed = 0;
  const deps = baseDeps({
    dispatchAgent: async () => ({ state: 'failed', error: 'boom' }),
    notifyRunCompleted: () => {
      completed += 1;
    },
  });

  const exec = DagExecutor.start(oneAgentWorkflow(), deps, ctxBase);
  const status = await exec.advance();

  assert.equal(status, 'failed');
  assert.equal(completed, 0, 'no completion nudge on a failed run');
});
