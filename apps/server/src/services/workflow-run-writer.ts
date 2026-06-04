// UI Spine step 2 / slice 004 — announcing write-door for workflow_runs_v2.
//
// EVERY mutation of a workflow_runs_v2 row MUST go through a function here.
// Slice 004: each function now routes through the WorkflowRunMutationGateway,
// which writes the repo change + a durable live_outbox row in ONE transaction.
// Slice 015c: the live-relay drains that committed outbox row post-commit and
// fans the canonical `live-event` frame to subscribers. Both the hand live-frame
// fanout (removed in 015b) AND the legacy `workflow-v2-run-changed` envelope
// (removed here — no live web consumer; the web reads the relay frame by
// `event.entity`) are GONE. "Forgetting to announce" stays structurally
// impossible (the outbox row is in the gateway txn).
//
// The `broadcast` callback is kept on the signatures for caller compatibility,
// but is now unused for run changes (delivery is door-only).

import type { ULID, WorkflowV2 } from '@pc/domain';
import { workflowRunsV2Repo, type WorkflowRunV2Record } from '@pc/db';
import {
  WorkflowRunMutationGateway,
  type WorkflowRunChangedPublication,
} from '@pc/app-services';
import {
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

/** Slice 015c — no-op. The canonical `live-event` frame is delivered by the
 *  live-relay draining the in-txn `live_outbox` row; the legacy
 *  `workflow-v2-run-changed` envelope is retired (no live web consumer). Kept as
 *  a seam so the announcing-write callers stay structurally identical. */
function fanout(_pub: WorkflowRunChangedPublication | null, _broadcast: RunBroadcast): void {
  /* relay-delivered; no hand fanout */
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

/** M6 slice C — CANCELLED IS FINAL for the advance path. A cancel can land
 *  while the executor has a layer in flight; when its persist arrives the
 *  status write must not resurrect the run. Race-free: the check runs inside
 *  the gateway txn. (The explicit resume door uses its OWN gateway call with
 *  repo setters directly — failed→running stays legal there.) */
function keepCancelled(id: ULID): boolean {
  return workflowRunsV2Repo.getRun(id)?.status === 'cancelled';
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
      if (!keepCancelled(id)) workflowRunsV2Repo.setStatus(id, status, opts);
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
      // dagState still lands (forensics: which nodes settled before the stop);
      // the cancelled STATUS is never overwritten.
      workflowRunsV2Repo.setDagState(id, dagState);
      if (!keepCancelled(id)) workflowRunsV2Repo.setStatus(id, status, opts);
      return workflowRunsV2Repo.getRun(id);
    },
  });
  fanout(pub, broadcast);
}
