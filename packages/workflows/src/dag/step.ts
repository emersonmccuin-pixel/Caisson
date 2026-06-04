// Section 19.4c — DAG executor brain. Pure, tick-driven state machine over
// WorkflowDagState. No I/O: the server (19.4d) loads state, calls these to
// decide what to do, then dispatches + persists. Matches PC's existing
// advance-on-event runtime model (NOT Archon's single-await loop).
//
// Flow per tick:
//   1. selectReady → which pending nodes can run now (+ which to skip)
//   2. server marks them running (markRunning) and dispatches
//   3. on a node settling, server calls settleNode / markAwaitingReview
//   4. on a review decision, server calls applyReviewDecision
//   5. computeRunStatus tells the server when the run is terminal / paused

import type { WorkflowV2 } from '@pc/domain';
import { computeUpstreams, forwardEdges } from './topo.ts';
import { checkTriggerRule, evaluateCondition } from './when.ts';
import type { RefResolver } from './refs.ts';

type Node = WorkflowV2.WorkflowNode;
type State = WorkflowV2.WorkflowDagState;
type NodeRunState = WorkflowV2.NodeRunState;

const SETTLED: ReadonlySet<NodeRunState> = new Set(['completed', 'failed', 'skipped']);

function isReviewNode(n: Node): n is WorkflowV2.ReviewNode {
  return n.kind === 'review';
}

function isLoopNode(n: Node): n is WorkflowV2.LoopNode {
  return n.kind === 'loop';
}

/** Map a node's run-state into the 5-term vocabulary checkTriggerRule expects.
 *  `awaiting-review` is in-flight, so it reads as `running` (not settled). */
function toTriggerState(
  s: NodeRunState
): 'completed' | 'failed' | 'skipped' | 'pending' | 'running' {
  return s === 'awaiting-review' ? 'running' : s;
}

function clone(state: State): State {
  return structuredClone(state);
}

/** Every node `pending`, no reject iterations yet. */
export function initDagState(workflow: WorkflowV2.Workflow): State {
  const nodes: Record<string, WorkflowV2.NodeRunRecord> = {};
  for (const n of workflow.nodes) nodes[n.id] = { state: 'pending' };
  return { nodes, rejectIterations: {} };
}

export type SkipReason = 'trigger_rule' | 'when_false' | 'when_parse_error';

export interface ReadySelection {
  /** Node ids whose dependencies are met and that should be dispatched now. */
  ready: string[];
  /** Nodes to mark skipped (deps settled but trigger_rule/when said no). */
  skips: { nodeId: string; reason: SkipReason }[];
}

/**
 * Decide which pending nodes are runnable now. A node is considered once all
 * its forward-predecessors are settled (completed/failed/skipped): then
 * trigger_rule + when: decide ready vs skip. Nodes still waiting on upstreams
 * are neither ready nor skipped (they wait for a later tick).
 */
export function selectReady(
  workflow: WorkflowV2.Workflow,
  state: State,
  resolveRef: RefResolver
): ReadySelection {
  const upstreams = computeUpstreams(workflow.nodes);
  const ready: string[] = [];
  const skips: { nodeId: string; reason: SkipReason }[] = [];

  for (const node of workflow.nodes) {
    // Loop nodes are routing, not flow — they never dispatch. Their record
    // only tracks iteration counts (written by applyReviewDecision).
    if (isLoopNode(node)) continue;
    if (state.nodes[node.id]?.state !== 'pending') continue;

    const ups = upstreams.get(node.id) ?? [];
    const upStates = ups.map((id) => state.nodes[id]?.state ?? 'pending');
    if (upStates.some((s) => !SETTLED.has(s))) continue; // still waiting

    if (checkTriggerRule(node.trigger_rule, upStates.map(toTriggerState)) === 'skip') {
      skips.push({ nodeId: node.id, reason: 'trigger_rule' });
      continue;
    }

    if (node.when !== undefined) {
      const { result, parsed } = evaluateCondition(node.when, resolveRef);
      if (!parsed) {
        skips.push({ nodeId: node.id, reason: 'when_parse_error' });
        continue;
      }
      if (!result) {
        skips.push({ nodeId: node.id, reason: 'when_false' });
        continue;
      }
    }

    ready.push(node.id);
  }

  return { ready, skips };
}

/** Mark a node `running` (server calls before dispatch). Bumps `iteration`. */
export function markRunning(state: State, nodeId: string, at = Date.now()): State {
  const next = clone(state);
  const prev = next.nodes[nodeId];
  next.nodes[nodeId] = {
    ...prev,
    state: 'running',
    iteration: (prev?.iteration ?? 0) + 1,
    startedAt: at,
  };
  return next;
}

/** Mark a review node `awaiting-review` (server calls after posting the gate). */
export function markAwaitingReview(state: State, nodeId: string): State {
  const next = clone(state);
  next.nodes[nodeId] = { ...next.nodes[nodeId], state: 'awaiting-review' };
  return next;
}

/** Record a node's terminal outcome (agent/bash/script nodes). */
export function settleNode(
  state: State,
  nodeId: string,
  outcome: {
    state: 'completed' | 'failed' | 'skipped';
    workItemId?: string;
    error?: string;
    /** Captured stdout for bash/script nodes — feeds `$nodeId.output` refs. */
    output?: string;
  },
  at = Date.now()
): State {
  const next = clone(state);
  next.nodes[nodeId] = {
    ...next.nodes[nodeId],
    state: outcome.state,
    ...(outcome.workItemId ? { workItemId: outcome.workItemId } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.output !== undefined ? { output: outcome.output } : {}),
    endedAt: at,
  };
  return next;
}

export function markSkipped(state: State, nodeId: string, reason: SkipReason, at = Date.now()): State {
  return settleNode(state, nodeId, { state: 'skipped', error: `skipped: ${reason}` }, at);
}

/**
 * Nodes on a forward path from `from` to `to` (inclusive) — the loop body a
 * reject edge resets. = forward-reachable(from) ∩ backward-reachable(to),
 * plus both endpoints.
 */
export function loopSubtree(workflow: WorkflowV2.Workflow, from: string, to: string): string[] {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const upstreams = computeUpstreams(workflow.nodes);

  const forward = new Set<string>();
  const fq = [from];
  while (fq.length) {
    const id = fq.pop()!;
    if (forward.has(id)) continue;
    forward.add(id);
    const node = byId.get(id);
    for (const s of node ? forwardEdges(node) : []) if (byId.has(s)) fq.push(s);
  }

  const backward = new Set<string>();
  const bq = [to];
  while (bq.length) {
    const id = bq.pop()!;
    if (backward.has(id)) continue;
    backward.add(id);
    for (const u of upstreams.get(id) ?? []) bq.push(u);
  }

  const subtree = new Set<string>([from, to]);
  for (const id of forward) if (backward.has(id)) subtree.add(id);
  return [...subtree].filter((id) => byId.has(id));
}

export type ReviewDecision = { kind: 'approve' } | { kind: 'reject'; notes?: string };

export interface ReviewOutcome {
  state: State;
  /** Node ids reset to pending for re-run (reject under ceiling); null otherwise. */
  kickedBack: string[] | null;
  /** True when the reject hit the iteration ceiling → route to Human Review. */
  heldForHuman: boolean;
}

const DEFAULT_MAX_ITERATIONS = 3;

/**
 * Resolve a review node. Approve → node completes (its `next` becomes
 * eligible). Reject → route to the review's `loop` node (FD-9): bump the
 * LOOP's iteration count; under the ceiling, reset the back_to→review loop
 * subtree to pending for re-run; at/over the ceiling, fail the review node and
 * flag a Human Review hold. A reject with no `reject` loop configured fails
 * the node (nowhere to kick back to).
 */
export function applyReviewDecision(
  workflow: WorkflowV2.Workflow,
  state: State,
  reviewNodeId: string,
  decision: ReviewDecision,
  at = Date.now()
): ReviewOutcome {
  const node = workflow.nodes.find((n) => n.id === reviewNodeId);
  let next = clone(state);

  if (decision.kind === 'approve') {
    next.nodes[reviewNodeId] = { ...next.nodes[reviewNodeId], state: 'completed', endedAt: at };
    return { state: next, kickedBack: null, heldForHuman: false };
  }

  // Stash the reviewer's notes at run-level so they survive the subtree reset
  // below and feed `loop.carry: { x: $self.output }` on re-dispatch.
  if (decision.notes) {
    next.rejectFeedback = { ...(next.rejectFeedback ?? {}), [reviewNodeId]: decision.notes };
  }

  const loopId = node && isReviewNode(node) ? node.reject : undefined;
  const loop = loopId ? workflow.nodes.find((n) => n.id === loopId) : undefined;
  if (!loop || !isLoopNode(loop)) {
    next.nodes[reviewNodeId] = {
      ...next.nodes[reviewNodeId],
      state: 'failed',
      error: 'review rejected (no loop step configured)',
      endedAt: at,
    };
    return { state: next, kickedBack: null, heldForHuman: false };
  }

  // Iterations are the LOOP's bookkeeping (it owns the ceiling); mirrored onto
  // its node record so the graph can badge "2/3".
  const count = (next.rejectIterations?.[loop.id] ?? 0) + 1;
  next.rejectIterations = { ...(next.rejectIterations ?? {}), [loop.id]: count };
  next.nodes[loop.id] = { ...next.nodes[loop.id], state: 'pending', iteration: count };

  const max = loop.max_iterations === undefined ? DEFAULT_MAX_ITERATIONS : loop.max_iterations;
  if (max !== null && count >= max) {
    // FD-11 (M6 slice C) — the ceiling PAUSES, it never executes: the review
    // goes back to awaiting-review (escalated to a HUMAN gate by the executor)
    // instead of failing the run. No work is lost; the human approves to
    // continue, rejects to keep it held, or cancels the run.
    next.nodes[reviewNodeId] = {
      ...next.nodes[reviewNodeId],
      state: 'awaiting-review',
      error: `loop iteration ceiling reached (${count}/${String(max)}) — escalated to human`,
    };
    return { state: next, kickedBack: null, heldForHuman: true };
  }

  const subtree = loopSubtree(workflow, loop.back_to, reviewNodeId);
  for (const id of subtree) {
    next.nodes[id] = { state: 'pending', iteration: next.nodes[id]?.iteration ?? 0 };
  }
  return { state: next, kickedBack: subtree, heldForHuman: false };
}

/**
 * M6 slice C (FD-11 req 2/3 — restart-at-step / the repair loop). A failed run
 * resumes against the CURRENT definition (re-frozen as the new snapshot), so
 * the repair "edit the def → resume from the failed step" actually picks up
 * the fix. Compatibility rule: every node the OLD run already settled
 * (completed) or is mid-tracking must still exist in the new def with the SAME
 * kind — otherwise the kept work would be meaningless. Returns one error per
 * problem; empty = compatible.
 */
export function resumeCompatErrors(
  workflow: WorkflowV2.Workflow,
  state: State,
): string[] {
  const errors: string[] = [];
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  for (const [nodeId, rec] of Object.entries(state.nodes)) {
    if (rec.state === 'pending') continue; // never ran — no kept work to honor
    const node = byId.get(nodeId);
    if (!node) {
      errors.push(
        `node "${nodeId}" (${rec.state}) no longer exists in the edited definition — its kept work has no home`,
      );
      continue;
    }
  }
  return errors;
}

/**
 * Reset a failed run's state for resume: failed / skipped / ghost-running
 * nodes go back to pending (their work re-runs); completed nodes and loop
 * bookkeeping (iterations, feedback) are KEPT. Returns the new state + the
 * node ids that were reset.
 */
export function resetFailedNodesForResume(
  workflow: WorkflowV2.Workflow,
  state: State,
): { state: State; resetNodes: string[] } {
  const next = clone(state);
  const resetNodes: string[] = [];
  for (const node of workflow.nodes) {
    if (isLoopNode(node)) continue; // routing bookkeeping — never reset
    const rec = next.nodes[node.id];
    if (!rec) {
      // A node ADDED by the repair edit — starts pending like any fresh node.
      next.nodes[node.id] = { state: 'pending' };
      continue;
    }
    if (rec.state === 'failed' || rec.state === 'skipped' || rec.state === 'running' || rec.state === 'awaiting-review') {
      next.nodes[node.id] = { state: 'pending', iteration: rec.iteration ?? 0 };
      resetNodes.push(node.id);
    }
  }
  return { state: next, resetNodes };
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'awaiting-review';

/**
 * Derive run-level status from node states. `awaiting-review` wins (a gate is
 * live). Else any pending/running → still running. Else all terminal: any
 * failure → failed; otherwise completed. Loop nodes are routing, not flow —
 * their records (eternally 'pending', tracking iterations) never gate the run.
 */
export function computeRunStatus(workflow: WorkflowV2.Workflow, state: State): RunStatus {
  const states = workflow.nodes
    .filter((n) => !isLoopNode(n))
    .map((n) => state.nodes[n.id]?.state ?? 'pending');
  if (states.some((s) => s === 'awaiting-review')) return 'awaiting-review';
  if (states.some((s) => s === 'pending' || s === 'running')) return 'running';
  return states.some((s) => s === 'failed') ? 'failed' : 'completed';
}
