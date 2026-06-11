// Review-gate idempotency + transport-drop fix (build-plan pc-pty-chat-211).
//
// Part 1 — Gate idempotency:
//   (a) A decision against a node that is NOT awaiting-review is rejected.
//   (b) Two sequential decisions against the same gate: first commits, second
//       returns `not-awaiting` (state unchanged after first commits).
//   (c) The per-run mutex serializes concurrent decisions: both go through the
//       lock; only the first commits; the second gets the guard.
//   (d) openReviewInstance is stamped on arm and cleared on commit.
//
// Part 2 — Transport drop fix (async advance):
//   (e) commitReviewDecision returns before advance() dispatches any agent
//       (response path is fast even when a reject loops back to an agent).
//
// Part 3 — Ceiling escalation:
//   (f) Ceiling re-posts with a NEW openReviewInstance (i<n>:escalated).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowV2 } from '@pc/domain';
import {
  applyReviewDecision,
  markAwaitingReview,
  initDagState,
  markRunning,
} from '@pc/workflows';

import { DagExecutor, type DagExecutorDeps, type NodeOutcome } from '../src/services/dag-executor.ts';
import type { ULID } from '@pc/domain';

// ── helpers ──────────────────────────────────────────────────────────────────

function loopWorkflow(maxIterations: number): WorkflowV2.Workflow {
  return {
    id: 'wf',
    name: 'Loop',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'coder', task: 'build', next: ['r'] },
      { id: 'r', kind: 'review', reviewer: 'human', reject: 'l' },
      { id: 'l', kind: 'loop', back_to: 'a', max_iterations: maxIterations },
    ],
  };
}

const ctxBase = { runId: 'run-1' as ULID, rootWorkItemId: 'wi-1' as ULID, worktreePath: null };

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

// ── Part 1a: state guard in applyReviewDecision ───────────────────────────────

test('applyReviewDecision: not-awaiting guard fires when node is pending', () => {
  const wf = loopWorkflow(3);
  const state = initDagState(wf); // all nodes pending

  const outcome = applyReviewDecision(wf, state, 'r', { kind: 'approve' });
  assert.ok(outcome.rejected === 'not-awaiting', 'pending node returns rejected');
  // State is unchanged — no mutation
  assert.deepStrictEqual(outcome.state, state);
});

test('applyReviewDecision: not-awaiting guard fires when node is completed', () => {
  const wf = loopWorkflow(3);
  let state = initDagState(wf);
  state = markRunning(state, 'r');
  state = markAwaitingReview(state, 'r', 'i0');
  // Apply an approval to settle the node
  const first = applyReviewDecision(wf, state, 'r', { kind: 'approve' });
  assert.ok(!first.rejected, 'first decision succeeds');
  // Second decision on the same node (now completed)
  const second = applyReviewDecision(wf, first.state, 'r', { kind: 'approve' });
  assert.ok(second.rejected === 'not-awaiting', 'second decision returns not-awaiting');
  assert.deepStrictEqual(second.state, first.state, 'state unchanged on guard');
});

// ── Part 1b: two sequential decisions ────────────────────────────────────────

test('applyReviewDecision: second reject after kick-back sees not-awaiting', () => {
  const wf = loopWorkflow(3);
  let state = initDagState(wf);
  state = markRunning(state, 'r');
  state = markAwaitingReview(state, 'r', 'i0');

  // First reject: kicks back, review node → pending
  const first = applyReviewDecision(wf, state, 'r', { kind: 'reject', notes: 'redo' });
  assert.ok(!first.rejected, 'first reject succeeds');
  assert.ok(first.kickedBack !== null, 'kick-back triggered');
  assert.equal(first.state.nodes['r']?.state, 'pending', 'review node reset to pending');

  // Second reject: gate is no longer awaiting-review
  const second = applyReviewDecision(wf, first.state, 'r', { kind: 'reject', notes: 'again' });
  assert.ok(second.rejected === 'not-awaiting', 'second reject returns not-awaiting');
  assert.deepStrictEqual(second.state, first.state, 'state unchanged on guard');
});

// ── Part 1d: openReviewInstance token lifecycle ───────────────────────────────

test('openReviewInstance: stamped on markAwaitingReview, cleared on approve', () => {
  const wf = loopWorkflow(3);
  let state = initDagState(wf);
  state = markRunning(state, 'r');

  // No token yet
  assert.equal(state.nodes['r']?.openReviewInstance, undefined);

  // Stamp token
  state = markAwaitingReview(state, 'r', 'i0');
  assert.equal(state.nodes['r']?.openReviewInstance, 'i0', 'token stamped on arm');

  // Apply approve: token should be cleared
  const outcome = applyReviewDecision(wf, state, 'r', { kind: 'approve' });
  assert.ok(!outcome.rejected);
  assert.equal(outcome.state.nodes['r']?.openReviewInstance, undefined, 'token cleared on approve');
});

test('openReviewInstance: subtree reset wipes token on kick-back', () => {
  const wf = loopWorkflow(3);
  let state = initDagState(wf);
  state = markRunning(state, 'r');
  state = markAwaitingReview(state, 'r', 'i0');

  const outcome = applyReviewDecision(wf, state, 'r', { kind: 'reject', notes: 'nope' });
  assert.ok(!outcome.rejected);
  // review node is in the subtree → reset to pending without token
  assert.equal(outcome.state.nodes['r']?.state, 'pending');
  assert.equal(outcome.state.nodes['r']?.openReviewInstance, undefined, 'token absent after kick-back reset');
});

// ── Part 3f: ceiling escalation stamps new instance token ────────────────────

test('openReviewInstance: ceiling stamps i<n>:escalated instance', () => {
  const wf = loopWorkflow(1); // max_iterations 1 → ceiling on first reject
  let state = initDagState(wf);
  state = markRunning(state, 'r');
  state = markAwaitingReview(state, 'r', 'i0');

  const outcome = applyReviewDecision(wf, state, 'r', { kind: 'reject', notes: 'bad' });
  assert.ok(!outcome.rejected, 'ceiling decision is not a guard rejection');
  assert.ok(outcome.heldForHuman, 'ceiling escalation flagged');
  assert.equal(
    outcome.state.nodes['r']?.openReviewInstance,
    'i1:escalated',
    'ceiling stamps escalated instance token',
  );
  assert.equal(outcome.state.nodes['r']?.state, 'awaiting-review');
});

test('applyReviewDecision on ceiling escalated gate: old instance reject blocked by state guard if node not awaiting', () => {
  // Simulates: pre-ceiling decision came in after the run advanced past the gate.
  const wf = loopWorkflow(1);
  let state = initDagState(wf);
  state = markRunning(state, 'r');
  state = markAwaitingReview(state, 'r', 'i0');

  // Ceiling hits: gate re-arms with 'i1:escalated'
  const ceiling = applyReviewDecision(wf, state, 'r', { kind: 'reject' });
  assert.ok(!ceiling.rejected && ceiling.heldForHuman);

  // Human approves the escalated gate → node completed
  const approved = applyReviewDecision(wf, ceiling.state, 'r', { kind: 'approve' });
  assert.ok(!approved.rejected && !approved.heldForHuman);
  assert.equal(approved.state.nodes['r']?.state, 'completed');

  // Now a replayed old reject arrives (gate already completed)
  const replay = applyReviewDecision(wf, approved.state, 'r', { kind: 'reject' });
  assert.ok(replay.rejected === 'not-awaiting', 'replayed reject blocked by state guard');
});

// ── Instance-token guard (reviewer feedback required fix) ─────────────────────
// A decision carrying a stale pre-ceiling token must be rejected with
// 'instance-mismatch' even though the escalated gate is also awaiting-review.

test('applyReviewDecision: instance-mismatch when expectedToken does not match openReviewInstance', () => {
  const wf = loopWorkflow(1); // max_iterations 1 → ceiling on first reject
  let state = initDagState(wf);
  state = markRunning(state, 'r');
  state = markAwaitingReview(state, 'r', 'i0');

  // Ceiling hit: gate re-arms with 'i1:escalated'
  const ceiling = applyReviewDecision(wf, state, 'r', { kind: 'reject' });
  assert.ok(!ceiling.rejected && ceiling.heldForHuman);
  assert.equal(ceiling.state.nodes['r']?.openReviewInstance, 'i1:escalated');

  // Stale pre-ceiling decision (token 'i0') against escalated gate ('i1:escalated')
  const stale = applyReviewDecision(wf, ceiling.state, 'r', { kind: 'approve' }, undefined, 'i0');
  assert.ok(stale.rejected === 'instance-mismatch', 'stale token → instance-mismatch');
  assert.deepStrictEqual(stale.state, ceiling.state, 'state unchanged on mismatch');
});

test('applyReviewDecision: matching token passes the instance guard', () => {
  const wf = loopWorkflow(1);
  let state = initDagState(wf);
  state = markRunning(state, 'r');
  state = markAwaitingReview(state, 'r', 'i0');

  // Ceiling hit
  const ceiling = applyReviewDecision(wf, state, 'r', { kind: 'reject' });
  assert.ok(!ceiling.rejected && ceiling.heldForHuman);

  // Correct escalated token
  const good = applyReviewDecision(wf, ceiling.state, 'r', { kind: 'approve' }, undefined, 'i1:escalated');
  assert.ok(!good.rejected, 'matching token accepted');
  assert.equal(good.state.nodes['r']?.state, 'completed');
});

test('applyReviewDecision: no token (backward compat) passes the instance guard', () => {
  const wf = loopWorkflow(1);
  let state = initDagState(wf);
  state = markRunning(state, 'r');
  state = markAwaitingReview(state, 'r', 'i0');

  const ceiling = applyReviewDecision(wf, state, 'r', { kind: 'reject' });
  assert.ok(!ceiling.rejected && ceiling.heldForHuman);

  // No token at all — backward compat: passes through to state guard only
  const noToken = applyReviewDecision(wf, ceiling.state, 'r', { kind: 'approve' });
  assert.ok(!noToken.rejected, 'no token is backward-compat accepted');
});

test('commitReviewDecision passes expectedInstanceToken to applyReviewDecision', async () => {
  const wf = loopWorkflow(1);
  const deps = baseDeps();
  const exec = DagExecutor.start(wf, deps, ctxBase);
  await exec.advance(); // arms gate with 'i0'
  assert.equal(exec.getState().nodes['r']?.openReviewInstance, 'i0');

  // Ceiling hit: re-arms with 'i1:escalated'
  await exec.commitReviewDecision('r', { kind: 'reject' });
  assert.equal(exec.getState().nodes['r']?.openReviewInstance, 'i1:escalated');

  // Stale token
  const stale = await exec.commitReviewDecision('r', { kind: 'approve' }, 'i0');
  assert.ok(stale.rejected === 'instance-mismatch', 'stale token surfaced as rejected');

  // Correct token
  const good = await exec.commitReviewDecision('r', { kind: 'approve' }, 'i1:escalated');
  assert.ok(!good.rejected, 'matching token accepted');
});

// ── Part 2e: commitReviewDecision returns before advance dispatches ───────────

test('commitReviewDecision returns before any agent is dispatched', async () => {
  const dispatchCalls: string[] = [];

  const deps = baseDeps({
    dispatchAgent: async (node): Promise<NodeOutcome> => {
      dispatchCalls.push(node.id);
      // Simulate a slow agent dispatch
      await new Promise((r) => setTimeout(r, 50));
      return { state: 'completed' };
    },
  });

  const exec = DagExecutor.start(loopWorkflow(3), deps, ctxBase);
  // Advance until the gate arms
  await exec.advance();
  assert.equal(exec.getState().nodes['r']?.state, 'awaiting-review');

  // commitReviewDecision should return immediately without dispatching
  const before = dispatchCalls.length;
  const commit = await exec.commitReviewDecision('r', { kind: 'reject', notes: 'try again' });
  assert.ok(!commit.rejected, 'commit succeeded');
  assert.equal(dispatchCalls.length, before, 'no dispatch during commit phase');

  // Only after advance() do agents get dispatched
  await exec.advance();
  assert.ok(dispatchCalls.length > before, 'advance dispatches after commit returns');
});

// ── DagExecutor.onReviewDecision: guard fires, returns current status ─────────

test('onReviewDecision on non-awaiting gate returns current run status without advancing', async () => {
  const dispatched: string[] = [];
  const deps = baseDeps({
    dispatchAgent: async (node): Promise<NodeOutcome> => {
      dispatched.push(node.id);
      return { state: 'completed' };
    },
  });

  // Manually build a state where the review is already completed (approved)
  const wf = loopWorkflow(3);
  let state = initDagState(wf);
  state = markRunning(state, 'r');
  state = markAwaitingReview(state, 'r', 'i0');
  const approved = applyReviewDecision(wf, state, 'r', { kind: 'approve' });
  assert.ok(!approved.rejected);

  const exec = DagExecutor.resume(wf, approved.state, deps, ctxBase);
  const before = dispatched.length;

  // onReviewDecision against a completed gate
  const status = await exec.onReviewDecision('r', { kind: 'reject' });
  // Should return a run status without dispatching anything (guard fired)
  assert.equal(dispatched.length, before, 'no dispatch on guarded onReviewDecision');
  // Status is still whatever computeRunStatus says
  assert.ok(typeof status === 'string', 'returns a run status string');
});
