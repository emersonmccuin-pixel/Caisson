// Workflow-run boot reconciliation (slice 004). None existed before; this
// mirrors agent-run-boot-reconcile but is pure + testable.
//
// Policy (v1, fail-closed — see slice doc Open Q2/Q3):
//  - `paused` runs: left untouched (a human/orchestrator review is the blocker;
//     the crash lost no work). No fact emitted.
//  - `running` runs: mid-advance when the process died. Mark `failed` with
//     last_reason='interrupted-on-boot' + emit workflow.run.changed
//     (reason:'reconciled'). Re-driving could double-execute a non-idempotent
//     node side effect; fail-closed is safe + observable.
//  - `pending` runs: fail-closed identically for uniformity.

import type { WorkflowRunV2Record } from '@pc/db';
import type { WorkflowV2 } from '@pc/domain';

const INTERRUPTED_REASON = 'interrupted-on-boot';

/** Statuses scanned for reconciliation. `paused` is included so the pass can
 *  see (and intentionally skip) review-blocked runs. */
export const RECONCILE_SCAN_STATUSES: readonly WorkflowV2.WorkflowRunStatus[] = [
  'pending',
  'running',
  'paused',
];

const FAIL_CLOSED: ReadonlySet<WorkflowV2.WorkflowRunStatus> = new Set(['pending', 'running']);

export interface WorkflowBootReconcileDeps {
  /** Lists non-terminal runs to consider (defaults wired at the server layer). */
  listRuns: () => WorkflowRunV2Record[];
  /** Fail-close one run + emit its reconciled fact. Returns the new rev/snapshot
   *  via the gateway publication; the server-side impl does the durable write +
   *  fanout. Called once per fail-closed run. */
  failClosed: (run: WorkflowRunV2Record, reason: string) => void;
}

export interface WorkflowBootReconcileResult {
  scanned: number;
  failed: number;
  skippedPaused: number;
}

export function reconcileWorkflowRunsOnBoot(
  deps: WorkflowBootReconcileDeps,
): WorkflowBootReconcileResult {
  const runs = deps.listRuns();
  let failed = 0;
  let skippedPaused = 0;
  for (const run of runs) {
    if (run.status === 'paused') {
      skippedPaused += 1;
      continue;
    }
    if (FAIL_CLOSED.has(run.status)) {
      deps.failClosed(run, INTERRUPTED_REASON);
      failed += 1;
    }
  }
  return { scanned: runs.length, failed, skippedPaused };
}

export { INTERRUPTED_REASON as WORKFLOW_INTERRUPTED_ON_BOOT_REASON };
