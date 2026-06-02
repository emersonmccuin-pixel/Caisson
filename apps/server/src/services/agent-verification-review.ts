// Section 26.6 / slice 020 — approve / reject service helpers (the
// /approve + /reject routes the merged `pc_resolve_work_item` MCP tool
// delegates to).
//
// Both verbs target tier-2/3 verification holds parked by slice 020 on the
// CONTRACT (`status: 'verifying'`, `verification_status: 'pending'`). They act
// on the contract; the work item (when one is linked) rolls up as a side
// effect on approve. They are orchestrator-only operations at v1 (tier-3 UI
// surface lands with Section 7; it'll call the same routes with a different
// `actor`).
//
// Approve:
//   - Flips the CONTRACT: `verificationStatus: 'passed'` → `status: 'accepted'`.
//   - Roll-up: when the contract has a linked work item, the WI flips to
//     `complete` + auto-advances to the done stage.
//   - No further agent dispatch; the producer run is already terminal.
//
// Reject:
//   - Flips the CONTRACT: `verificationStatus: 'failed'` → `status: 'rejected'`.
//   - Resolves the producer run from `contract.agentRunId` and spawns a
//     continuation (Section 21's primitive) with the feedback wrapped as the
//     resumed user message.
//
// The route still addresses the hold by work-item id; the service resolves the
// verifying contract linked to that WI. (Slice 021 repoints the tools to be
// contract-native.)

import type { Contract } from '@pc/contracts';
import { ContractService } from '@pc/app-services';
import { applyAgentVerification, getWorkItem } from '@pc/db';
import type { Project, ULID, WorkItem } from '@pc/domain';

import { autoAdvanceToDoneStage } from './auto-advance-done.ts';
import { announceWorkItemRow } from './work-item-writer.ts';
import type { MailboxEnqueuePort } from './agent-delivery.ts';
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
  /** Optional reviewer note. Surfaces in the contract `verificationNotes`. */
  notes?: string | null;
  /** Who approved — drives the history note's audit attribution. v1 stays
   *  orchestrator-only; Section 7 will pass `'user'` for inbox approvals. */
  actor?: 'orchestrator' | 'user';
  /** Section 27.7 — project record. When provided + project has an `is_done`
   *  stage, the rolled-up WI auto-advances there after the flip. */
  project?: Project | null;
}

export interface ApproveAgentWorkItemDeps {
  contractService?: ContractService;
}

/** Approve a tier-2/3 verification hold on the contract. Rolls up the linked
 *  work item (if any) to complete + the done stage. Returns the updated
 *  WorkItem when one is linked, else null (a contract-only hold). */
export function approveAgentWorkItem(
  input: ApproveAgentWorkItemInput,
  deps: ApproveAgentWorkItemDeps = {},
): WorkItem | null {
  const service = deps.contractService ?? new ContractService();
  const contract = loadVerifyingContract(input.workItemId, service);
  const note = input.notes?.trim() ?? '';
  service.setVerification({
    id: contract.id as ULID,
    verificationStatus: 'passed',
    verificationNotes: note || null,
  });

  // Roll-up: advance the linked work item, if one exists.
  if (!contract.workItemId) return null;
  const wiId = contract.workItemId as ULID;
  const actor = input.actor ?? 'orchestrator';
  const updated = applyAgentVerification(wiId, {
    workItemStatus: 'complete',
    statusReason: null,
    verificationStatus: 'passed',
    verificationNotes: note || null,
    historyNote: note ? `approved by ${actor}: ${note}` : `approved by ${actor}`,
  });
  if (!updated) {
    throw new VerificationReviewError('wi-not-found', `work item ${wiId} disappeared mid-write`);
  }
  if (input.project) {
    const advanced = autoAdvanceToDoneStage(wiId, input.project);
    if (advanced) {
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
  /** The updated WorkItem when one is linked to the contract, else null. */
  workItem: WorkItem | null;
  /** The rejected contract. */
  contract: Contract;
  /** The continuation dispatch outcome. `ok: false` when the parent run is
   *  no longer continuable (session-expired / not-continuable / etc.) — the
   *  contract flip still happened; the agent just didn't get woken back up. */
  continuation: DispatchAgentResult;
}

export interface RejectAgentWorkItemDeps {
  /** Mailbox enqueue port — threaded into the rejection continuation dispatch
   *  so its eventual terminal envelope is delivered. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  hostClient?: AgentHostReattachClient | null;
  broadcast?: (env: { type: string; [k: string]: unknown }) => void;
  /** Test seam — production uses `dispatchContinueAgent` from the agent-run
   *  factory. Injecting lets unit tests stub the continuation result without
   *  the full spawn pipeline. */
  dispatch?: typeof dispatchContinueAgent;
  contractService?: ContractService;
}

/** Reject a tier-2/3 verification hold on the contract + wake the producer run
 *  (resolved from `contract.agentRunId`) with the feedback. Returns the updated
 *  WI (if linked) + the rejected contract + the continuation dispatch result. */
export async function rejectAgentWorkItem(
  input: RejectAgentWorkItemInput,
  deps: RejectAgentWorkItemDeps,
): Promise<RejectAgentWorkItemResult> {
  const feedback = input.feedback?.trim() ?? '';
  if (!feedback) {
    throw new VerificationReviewError('feedback-required', 'feedback required for reject');
  }
  const service = deps.contractService ?? new ContractService();
  const contract = loadVerifyingContract(input.workItemId, service);
  if (!contract.agentRunId) {
    throw new VerificationReviewError(
      'no-assigned-run',
      `contract ${contract.id} has no agentRunId — was it dispatched via pc_invoke_agent?`,
    );
  }
  const actor = input.actor ?? 'orchestrator';

  // Flip the contract to rejected.
  service.setVerification({
    id: contract.id as ULID,
    verificationStatus: 'failed',
    verificationNotes: feedback,
  });

  // Roll the WI back to in-progress, if one is linked.
  let updated: WorkItem | null = null;
  if (contract.workItemId) {
    const wiId = contract.workItemId as ULID;
    const truncated = feedback.length > 240 ? `${feedback.slice(0, 240)}…` : feedback;
    updated = applyAgentVerification(wiId, {
      workItemStatus: 'in-progress',
      statusReason: 'rejected on verification — feedback wired to continuation',
      verificationStatus: 'failed',
      verificationNotes: feedback,
      historyNote: `rejected by ${actor}: ${truncated}`,
    });
    if (updated) announceWorkItemRow(updated, updated.projectId, 'rejected');
  }

  // Phrase the resumed-agent's next user message so the agent treats this as
  // a critique-and-retry, not a fresh ask. The agent already has its prior
  // conversation in scope via `--resume`.
  const continuationInput = `Reviewer rejected your previous deliverable on contract ${contract.id} with this feedback:\n\n${feedback}\n\nAddress the feedback, then re-submit your deliverable via pc_submit_deliverable before reporting done.`;

  const dispatch = deps.dispatch ?? dispatchContinueAgent;
  const continuation = await dispatch(
    {
      projectId: input.project.id,
      worktreeDir: input.project.folderPath,
      parentAgentRunId: contract.agentRunId as ULID,
      input: continuationInput,
      dispatcherSessionId: input.dispatcherSessionId,
      ...(contract.workItemId ? { workItemId: contract.workItemId as ULID } : {}),
      slug: input.project.slug,
    },
    {
      ...(deps.mailboxEnqueue ? { mailboxEnqueue: deps.mailboxEnqueue } : {}),
      ...(deps.broadcast ? { broadcast: deps.broadcast } : {}),
      ...(deps.hostClient ? { hostClient: deps.hostClient } : {}),
    },
  );

  return { workItem: updated, contract, continuation };
}

/** Shared guard for approve + reject. Resolves the verifying contract linked to
 *  the work item id the route addressed. Throws `VerificationReviewError` on any
 *  precondition miss. */
function loadVerifyingContract(workItemId: ULID, service: ContractService): Contract {
  const wi = getWorkItem(workItemId);
  if (!wi) {
    throw new VerificationReviewError('wi-not-found', `work item ${workItemId} not found`);
  }
  const contracts = service.listByWorkItem(workItemId);
  // Prefer a contract parked in `verifying`; newest wins.
  const verifying = contracts.filter((c) => c.status === 'verifying');
  const contract = verifying.length > 0 ? verifying[verifying.length - 1]! : null;
  if (!contract) {
    throw new VerificationReviewError(
      'not-awaiting-verification',
      `work item ${workItemId} has no contract awaiting verification`,
    );
  }
  return contract;
}
