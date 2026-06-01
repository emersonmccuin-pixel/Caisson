// UI Spine step 2 / slice 004 — announcing write-door for workflow_runs_v2.
//
// EVERY mutation of a workflow_runs_v2 row MUST go through a function here.
// Slice 004: each function now routes through the WorkflowRunMutationGateway,
// which writes the repo change + a durable live_outbox row in ONE transaction.
// After commit we fan out BOTH the canonical {type:'live-event'} frame (new
// clients) and the legacy `workflow-v2-run-changed` envelope (compat) via the
// supplied `broadcast`. "Forgetting to announce" stays structurally impossible.
//
// The `broadcast` callback is `(event: unknown) => void` scoped to a single
// project — callers typically pass `opts.broadcast` from DagRunServiceOptions
// or a `broadcastTo(projectId, ...)` lambda.

import type { ULID, WorkflowV2 } from '@pc/domain';
import { workflowRunsV2Repo, type WorkflowRunV2Record } from '@pc/db';
import {
  WorkflowRunMutationGateway,
  type WorkflowRunChangedPublication,
} from '@pc/app-services';
import {
  buildWorkflowRunChangedRefetchEnvelope,
  type WorkflowRunChangedReason,
} from '@pc/contracts';

export type RunBroadcast = (event: unknown) => void;

const gateway = new WorkflowRunMutationGateway();

/** Map a run status to the canonical change reason for an advance/status write. */
function reasonForStatus(status: WorkflowV2.WorkflowRunStatus): WorkflowRunChangedReason {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'paused':
      return 'review-pending';
    default:
      return 'advanced';
  }
}

/** Fan out a gateway publication. Slice 015b: the canonical `live-event` frame
 *  is now delivered by the live-relay draining the in-txn `live_outbox` row —
 *  the hand frame fanout is GONE (the web consumes the relay frame by
 *  `event.entity`). The legacy `workflow-v2-run-changed` envelope stays for the
 *  drawer / other consumers until slice 015c retires it. */
function fanout(pub: WorkflowRunChangedPublication | null, broadcast: RunBroadcast): void {
  if (!pub) return;
  broadcast(
    buildWorkflowRunChangedRefetchEnvelope({ projectId: pub.run.projectId, run: pub.run }),
  );
}

/** Read the full row and broadcast a versioned snapshot. No-ops if the row
 *  is gone (caller's write was a no-op too). */
export function announceRun(
  id: ULID,
  projectId: ULID,
  broadcast: RunBroadcast,
  reason: WorkflowRunChangedReason = 'advanced',
): void {
  fanout(gateway.announceRunChange({ projectId, reason, runId: id }), broadcast);
}

// ---------------------------------------------------------------------------
// Announcing write functions — the ONLY paths that mutate workflow_runs_v2.
// ---------------------------------------------------------------------------

/** Announce an already-created run (call right after createRun + markStarted). */
export function announceRunCreated(
  run: WorkflowRunV2Record,
  projectId: ULID,
  broadcast: RunBroadcast,
): void {
  fanout(gateway.announceRunChange({ projectId, reason: 'fired', runId: run.id }), broadcast);
}

/** setDagState + announce (atomic durable fact via the gateway). */
export function writeDagState(
  id: ULID,
  dagState: WorkflowV2.WorkflowDagState,
  projectId: ULID,
  broadcast: RunBroadcast,
): void {
  const pub = gateway.commitRunChange({
    projectId,
    reason: 'advanced',
    mutate: () => {
      workflowRunsV2Repo.setDagState(id, dagState);
      return workflowRunsV2Repo.getRun(id);
    },
  });
  fanout(pub, broadcast);
}

/** setStatus + announce (atomic durable fact via the gateway). */
export function writeRunStatus(
  id: ULID,
  status: WorkflowV2.WorkflowRunStatus,
  opts: { lastReason?: string | null },
  projectId: ULID,
  broadcast: RunBroadcast,
): void {
  const pub = gateway.commitRunChange({
    projectId,
    reason: reasonForStatus(status),
    mutate: () => {
      workflowRunsV2Repo.setStatus(id, status, opts);
      return workflowRunsV2Repo.getRun(id);
    },
  });
  fanout(pub, broadcast);
}

/** setDagState + setStatus + single announce (used by persist()). */
export function writeDagAndStatus(
  id: ULID,
  dagState: WorkflowV2.WorkflowDagState,
  status: WorkflowV2.WorkflowRunStatus,
  opts: { lastReason?: string },
  projectId: ULID,
  broadcast: RunBroadcast,
): void {
  const pub = gateway.commitRunChange({
    projectId,
    reason: reasonForStatus(status),
    mutate: () => {
      workflowRunsV2Repo.setDagState(id, dagState);
      workflowRunsV2Repo.setStatus(id, status, opts);
      return workflowRunsV2Repo.getRun(id);
    },
  });
  fanout(pub, broadcast);
}
