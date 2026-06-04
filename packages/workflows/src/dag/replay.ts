// M6 slice D — FD-13 guard: the run diary is provably the truth. This module
// derives per-node execution states by REPLAYING `workflow_run_events` through
// the same pure transitions the executor uses. The guard test asserts the
// derived states ≡ the executor's dagState after a real (reject-loop) run —
// if a state transition ever ships without its diary line, the guard breaks.
//
// Deliberately NOT the operational path: dag_state on the run row stays the
// fast resume cache (FD-13 keeps configuration-as-rows / happenings-as-logs
// without a projection rewrite). This is the drift alarm.

import type { WorkflowV2 } from '@pc/domain';
import {
  applyReviewDecision,
  initDagState,
  markAwaitingReview,
  markRunning,
  resetFailedNodesForResume,
  settleNode,
} from './step.ts';

export interface ReplayDiaryEvent {
  type: string;
  nodeId?: string | null;
  data?: Record<string, unknown> | null;
}

/** Replay a run's diary into per-node states. Returns the derived DagState —
 *  compare `nodes[*].state` (timestamps/outputs are not derivable and not the
 *  point). */
export function deriveDagStateFromDiary(
  workflow: WorkflowV2.Workflow,
  events: readonly ReplayDiaryEvent[],
): WorkflowV2.WorkflowDagState {
  let state = initDagState(workflow);
  for (const ev of events) {
    const nodeId = ev.nodeId ?? undefined;
    switch (ev.type) {
      case 'node_started':
        if (nodeId) state = markRunning(state, nodeId);
        break;
      case 'node_completed':
        if (nodeId) state = settleNode(state, nodeId, { state: 'completed' });
        break;
      case 'node_failed':
        if (nodeId)
          state = settleNode(state, nodeId, {
            state: 'failed',
            ...(typeof ev.data?.error === 'string' ? { error: ev.data.error } : {}),
          });
        break;
      case 'node_skipped':
        if (nodeId) state = settleNode(state, nodeId, { state: 'skipped' });
        break;
      case 'review_requested':
        // Both the normal gate post and the ceiling re-post (escalated) park
        // the review at awaiting-review.
        if (nodeId) {
          state = markRunning(state, nodeId);
          state = markAwaitingReview(state, nodeId);
        }
        break;
      case 'review_approved':
        if (nodeId) state = applyReviewDecision(workflow, state, nodeId, { kind: 'approve' }).state;
        break;
      case 'review_rejected':
        if (nodeId) state = applyReviewDecision(workflow, state, nodeId, { kind: 'reject' }).state;
        break;
      case 'run_resumed':
        state = resetFailedNodesForResume(workflow, state).state;
        break;
      // Informational lines — no node-state transition to replay:
      // workflow_started/completed/failed/cancelled · run_interrupted ·
      // agent_dispatched · iteration_ceiling_hit · card_moved.
      default:
        break;
    }
  }
  return state;
}
