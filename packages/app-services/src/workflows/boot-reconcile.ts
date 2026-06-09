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

/** Returns true if every in-flight (running) node in the run is a `merge` node.
 *  Conservatively returns false on parse errors so the fallback fail-close fires. */
function hasOnlyMergeInFlight(run: WorkflowRunV2Record): boolean {
  try {
    const wf = JSON.parse(run.workflowYamlSnapshot) as WorkflowV2.Workflow;
    const inFlight = Object.entries(run.dagState.nodes)
      .filter(([, rec]) => rec.state === 'running')
      .map(([id]) => id);
    if (inFlight.length === 0) return false;
    const byId = new Map(wf.nodes.map((n) => [n.id, n]));
    return inFlight.every((id) => byId.get(id)?.kind === 'merge');
  } catch {
    return false;
  }
}

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
  /** pc-pty-chat-270 Chunk B step 10: called INSTEAD of failClosed for a
   *  `running` run whose only in-flight nodes are `merge` nodes. The merge
   *  step is idempotent against actual git state, so re-driving it is safe
   *  (and correct — git may have already completed the merge before the
   *  crash). The dep is optional: if absent, merge-in-progress runs fall
   *  back to the normal fail-close path. */
  reDriveMerge?: (run: WorkflowRunV2Record) => void;
}

export interface WorkflowBootReconcileResult {
  scanned: number;
  failed: number;
  skippedPaused: number;
  /** Runs re-driven via the idempotent merge step instead of fail-closed. */
  reDriven: number;
}

export function reconcileWorkflowRunsOnBoot(
  deps: WorkflowBootReconcileDeps,
): WorkflowBootReconcileResult {
  const runs = deps.listRuns();
  let failed = 0;
  let skippedPaused = 0;
  let reDriven = 0;
  for (const run of runs) {
    if (run.status === 'paused') {
      skippedPaused += 1;
      continue;
    }
    if (FAIL_CLOSED.has(run.status)) {
      // pc-pty-chat-270 Chunk B step 10: a running run with only merge nodes
      // in-flight must not fail-close — the merge step is idempotent against
      // git state, so re-driving it is safe (git may have already merged
      // before the crash).
      if (deps.reDriveMerge && hasOnlyMergeInFlight(run)) {
        deps.reDriveMerge(run);
        reDriven += 1;
        continue;
      }
      deps.failClosed(run, INTERRUPTED_REASON);
      failed += 1;
    }
  }
  return { scanned: runs.length, failed, skippedPaused, reDriven };
}

export { INTERRUPTED_REASON as WORKFLOW_INTERRUPTED_ON_BOOT_REASON };
