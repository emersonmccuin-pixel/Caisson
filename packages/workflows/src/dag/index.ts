// Section 19.4 — pure DAG executor core (topology + when: + ref substitution).
// I/O-free; the server orchestration layer (apps/server) provides the
// RefResolver that reads child work items.
export { buildTopologicalLayers, computeUpstreams, forwardEdges, findForwardCycle } from './topo.ts';
export { evaluateCondition, checkTriggerRule } from './when.ts';
export { validateWorkflowV2, type ValidationResult } from './validate.ts';
export { deriveDagStateFromDiary, type ReplayDiaryEvent } from './replay.ts';
export {
  substituteRefs,
  substituteInputs,
  extractInputPlaceholders,
  shellQuote,
  type RefResolver,
} from './refs.ts';
export {
  initDagState,
  selectReady,
  markRunning,
  markAwaitingReview,
  settleNode,
  markSkipped,
  loopSubtree,
  applyReviewDecision,
  computeRunStatus,
  resumeCompatErrors,
  resetFailedNodesForResume,
  type ReadySelection,
  type SkipReason,
  type ReviewDecision,
  type ReviewOutcome,
  type RunStatus,
} from './step.ts';
