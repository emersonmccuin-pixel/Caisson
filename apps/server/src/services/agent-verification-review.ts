// Section 26.6 — `pc_approve_work_item` / `pc_reject_work_item` service helpers.
//
// Both verbs target tier-2/3 verification holds parked by Section 26.5 in
// `awaiting-verification` + `verification_status: 'pending'`. They are
// orchestrator-only operations at v1 (tier-3 UI surface lands with Section 7;
// it'll call the same routes through the same path with different `actor`).
//
// Approve:
//   - Flips WI: `status: 'complete'`, `verificationStatus: 'passed'`.
//   - Optional `notes` lands in `verificationNotes` + the history entry.
//   - No further agent dispatch; the producer run is already terminal.
//
// Reject:
//   - Flips WI: `status: 'in-progress'`, `verificationStatus: 'failed'`,
//     `verificationNotes: feedback`.
//   - Spawns a continuation of the producer run (Section 21's primitive) with
//     the feedback wrapped as the resumed user message. The resumed agent
//     reads the WI's updated body / verification_notes and tries again.
//
// Guards: WI exists, `isAgentTask=true`, `verificationStatus='pending'`.
// Reject also requires non-empty feedback + a non-null `assignedAgentRunId`
// (Section 26.6 dispatch path writes that field).

import { applyAgentVerification, getWorkItem } from '@pc/db';
import type { Project, ULID, WorkItem } from '@pc/domain';

import { autoAdvanceToDoneStage } from './auto-advance-done.ts';
import { announceWorkItemRow } from './work-item-writer.ts';
import type { ChannelServer } from './channel-server.ts';
import {
  dispatchContinueAgent,
  type DispatchAgentResult,
} from './agent-run-factory.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';

/** Error class for v1 422 surfaces (precondition / not-found that the route
 *  maps to a clean HTTP status). Carrying the cause through lets the route
 *  pick 404 / 409 / 400 without re-string-matching. */
export class VerificationReviewError extends Error {
  constructor(
    public readonly cause:
      | 'wi-not-found'
      | 'not-agent-task'
      | 'not-awaiting-verification'
      | 'feedback-required'
      | 'no-assigned-run',
    message: string,
  ) {
    super(message);
    this.name = 'VerificationReviewError';
  }
}

export interface ApproveAgentWorkItemInput {
  workItemId: ULID;
  /** Optional reviewer note. Surfaces in `verificationNotes` + history. */
  notes?: string | null;
  /** Who approved — drives the history note's audit attribution. v1 stays
   *  orchestrator-only; Section 7 will pass `'user'` for inbox approvals. */
  actor?: 'orchestrator' | 'user';
  /** Section 27.7 — project record. When provided + project has an `is_done`
   *  stage, the approved WI auto-advances there after the flip. */
  project?: Project | null;
}

/** Approve a tier-2/3 verification hold. Returns the updated WorkItem (already
 *  advanced to the is_done stage if 27.7's auto-advance fired). */
export function approveAgentWorkItem(input: ApproveAgentWorkItemInput): WorkItem {
  const wi = loadVerificationCandidate(input.workItemId);
  const actor = input.actor ?? 'orchestrator';
  const note = input.notes?.trim() ?? '';
  const historyNote = note
    ? `approved by ${actor}: ${note}`
    : `approved by ${actor}`;
  const updated = applyAgentVerification(wi.id, {
    workItemStatus: 'complete',
    statusReason: null,
    verificationStatus: 'passed',
    verificationNotes: note || null,
    historyNote,
  });
  if (!updated) {
    throw new VerificationReviewError('wi-not-found', `work item ${wi.id} disappeared mid-write`);
  }
  if (input.project) {
    const advanced = autoAdvanceToDoneStage(wi.id, input.project);
    if (advanced) {
      // Slice 015b — announce through the durable door; relay delivers the frame.
      announceWorkItemRow(advanced, advanced.projectId, 'auto-advanced');
      return advanced;
    }
  }
  announceWorkItemRow(updated, updated.projectId, 'approved');
  return updated;
}

export interface RejectAgentWorkItemInput {
  workItemId: ULID;
  feedback: string;
  actor?: 'orchestrator' | 'user';
  /** Caller's PC session-id. Forwarded to `dispatchContinueAgent` as the
   *  ownership identity on the continuation. Required because the
   *  continuation respects the parent run's `dispatcher_session_id`. */
  dispatcherSessionId: string;
  /** Project record — passed through to the continuation dispatch so it can
   *  resolve the worktree + slug + folder path. */
  project: Project;
}

export interface RejectAgentWorkItemResult {
  workItem: WorkItem;
  /** The continuation dispatch outcome. `ok: false` when the parent run is
   *  no longer continuable (session-expired / not-continuable / etc.) — the
   *  WI flip still happened; the agent just didn't get woken back up.
   *  Caller decides whether to surface the failure or recover. */
  continuation: DispatchAgentResult;
}

export interface RejectAgentWorkItemDeps {
  channelServer: ChannelServer;
  hostClient?: AgentHostReattachClient | null;
  broadcast?: (env: { type: string; [k: string]: unknown }) => void;
  /** Test seam — production uses `dispatchContinueAgent` from the agent-run
   *  factory. Injecting lets unit tests stub the continuation result without
   *  the full spawn pipeline. */
  dispatch?: typeof dispatchContinueAgent;
}

/** Reject a tier-2/3 verification hold + wake the producer run with the
 *  feedback. Returns the updated WI + the continuation dispatch result. */
export async function rejectAgentWorkItem(
  input: RejectAgentWorkItemInput,
  deps: RejectAgentWorkItemDeps,
): Promise<RejectAgentWorkItemResult> {
  const feedback = input.feedback?.trim() ?? '';
  if (!feedback) {
    throw new VerificationReviewError('feedback-required', 'feedback required for reject');
  }
  const wi = loadVerificationCandidate(input.workItemId);
  if (!wi.assignedAgentRunId) {
    throw new VerificationReviewError(
      'no-assigned-run',
      `work item ${wi.id} has no assigned_agent_run_id — was it dispatched via pc_invoke_agent({ workItemId })?`,
    );
  }
  const actor = input.actor ?? 'orchestrator';
  // Truncate the feedback in the history note so a long rejection body
  // doesn't bloat the row. Full feedback persists in verification_notes.
  const truncated = feedback.length > 240 ? `${feedback.slice(0, 240)}…` : feedback;
  const updated = applyAgentVerification(wi.id, {
    workItemStatus: 'in-progress',
    statusReason: 'rejected on verification — feedback wired to continuation',
    verificationStatus: 'failed',
    verificationNotes: feedback,
    historyNote: `rejected by ${actor}: ${truncated}`,
  });
  if (!updated) {
    throw new VerificationReviewError('wi-not-found', `work item ${wi.id} disappeared mid-write`);
  }
  // Slice 015b — announce the WI flip through the durable door; relay delivers.
  announceWorkItemRow(updated, updated.projectId, 'rejected');

  // Phrase the resumed-agent's next user message so the agent treats this as
  // a critique-and-retry, not a fresh ask. The agent already has its prior
  // conversation in scope via `--resume`.
  const continuationInput = `Reviewer rejected your previous report on work item ${wi.id} with this feedback:\n\n${feedback}\n\nRe-read the work item (pc_get_work_item) for the latest body + verification notes, address the feedback, and produce a revised report. Update body / attachments as needed before reporting done.`;

  const dispatch = deps.dispatch ?? dispatchContinueAgent;
  const continuation = await dispatch(
    {
      projectId: input.project.id,
      worktreeDir: input.project.folderPath,
      parentAgentRunId: wi.assignedAgentRunId,
      input: continuationInput,
      dispatcherSessionId: input.dispatcherSessionId,
      workItemId: wi.id,
      slug: input.project.slug,
    },
    {
      channelServer: deps.channelServer,
      ...(deps.broadcast ? { broadcast: deps.broadcast } : {}),
      ...(deps.hostClient ? { hostClient: deps.hostClient } : {}),
    },
  );

  return { workItem: updated, continuation };
}

/** Shared guard for approve + reject. Throws `VerificationReviewError` on
 *  any precondition miss. */
function loadVerificationCandidate(id: ULID): WorkItem {
  const wi = getWorkItem(id);
  if (!wi) {
    throw new VerificationReviewError('wi-not-found', `work item ${id} not found`);
  }
  if (!wi.isAgentTask) {
    throw new VerificationReviewError(
      'not-agent-task',
      `work item ${id} is not an agent contract (isAgentTask=false)`,
    );
  }
  if (wi.verificationStatus !== 'pending') {
    throw new VerificationReviewError(
      'not-awaiting-verification',
      `work item ${id} is not awaiting verification (status=${wi.status}, verification_status=${wi.verificationStatus ?? 'null'})`,
    );
  }
  return wi;
}
