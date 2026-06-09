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
import { ContractService, WorkItemMutationGateway } from '@pc/app-services';
import { applyRunOutcome, getAgentRunRow, getWorkItem } from '@pc/db';
import type { Project, ULID, WorkItem } from '@pc/domain';

import { autoAdvanceToDoneStage } from './auto-advance-done.ts';
import type { MailboxEnqueuePort } from './agent-delivery.ts';
import {
  dispatchContinueAgent,
  type DispatchAgentResult,
} from './agent-run-factory.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';
import type { ReviewInboxResolution } from './dag-run-service.ts';

/** FD-12 — the one write door (repo write + outbox receipt in one txn). */
const gateway = new WorkItemMutationGateway();

/** M8 (FD-7) — a verification hold decided through ANY door (inbox card,
 *  orchestrator pc_resolve_work_item, raw HTTP) actions the contract's open
 *  `verification-review` inbox cards so they never linger. Best-effort: the
 *  decision itself never fails on inbox bookkeeping. */
function resolveVerificationInbox(
  reviewInbox: ReviewInboxResolution | null | undefined,
  contractId: string,
): void {
  if (!reviewInbox) return;
  try {
    const open = reviewInbox.collectUnactionedRecipients('agent-contract', contractId);
    if (open.length > 0) reviewInbox.actionRecipients(open, Date.now());
  } catch {
    /* inbox bookkeeping must never fail the decision */
  }
}

/** Error class for v1 422 surfaces (precondition / not-found that the route
 *  maps to a clean HTTP status). Carrying the cause through lets the route
 *  pick 404 / 409 / 400 without re-string-matching. */
export class VerificationReviewError extends Error {
  constructor(
    public readonly cause:
      | 'wi-not-found'
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
  /** M8 (FD-7) — decided-elsewhere inbox resolution (MailboxService pair). */
  reviewInbox?: ReviewInboxResolution | null;
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
  resolveVerificationInbox(deps.reviewInbox, contract.id);

  // Roll-up: advance the linked work item, if one exists.
  if (!contract.workItemId) return null;
  const wiId = contract.workItemId as ULID;
  const actor = input.actor ?? 'orchestrator';
  const pre = getWorkItem(wiId);
  if (!pre) {
    throw new VerificationReviewError('wi-not-found', `work item ${wiId} disappeared mid-write`);
  }
  // FD-12 — status flip + optional auto-advance + the ONE receipt in ONE
  // gateway transaction (reason = auto-advanced when the stage move fires,
  // else approved — same single-event surface as before). The contract owns
  // verification status/notes; the WI roll-up only flips status + appends a
  // history note.
  let result!: WorkItem;
  gateway.tryCommitWorkItemChange({
    projectId: pre.projectId,
    mutate: () => {
      const updated = applyRunOutcome(
        wiId,
        'complete',
        null,
        note ? `approved by ${actor}: ${note}` : `approved by ${actor}`,
      );
      if (!updated) {
        throw new VerificationReviewError('wi-not-found', `work item ${wiId} disappeared mid-write`);
      }
      result = updated;
      if (input.project) {
        const advanced = autoAdvanceToDoneStage(wiId, input.project);
        if (advanced) {
          result = advanced;
          return { row: advanced, reason: 'auto-advanced' };
        }
      }
      return { row: updated, reason: 'approved' };
    },
  });
  return result;
}

export interface RejectAgentWorkItemInput {
  workItemId: ULID;
  feedback: string;
  actor?: 'orchestrator' | 'user';
  /** Caller's PC session-id, forwarded to `dispatchContinueAgent` as the
   *  ownership identity on the continuation. M8 (FD-7): optional — a human
   *  deciding from the Inbox card has no PC session; the continuation then
   *  inherits the PARENT run's `dispatcher_session_id` (the original owner
   *  keeps getting the envelopes). */
  dispatcherSessionId?: string | null;
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
  /** M8 (FD-7) — decided-elsewhere inbox resolution (MailboxService pair). */
  reviewInbox?: ReviewInboxResolution | null;
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
  // M8 (FD-7) — Inbox-card rejects carry no PC session; the continuation
  // inherits the parent run's dispatcher identity.
  const dispatcherSessionId =
    input.dispatcherSessionId?.trim() ||
    getAgentRunRow(contract.agentRunId as ULID)?.dispatcherSessionId ||
    '';
  if (!dispatcherSessionId) {
    throw new VerificationReviewError(
      'no-assigned-run',
      `contract ${contract.id}'s producer run has no dispatcher session to continue under`,
    );
  }

  // Flip the contract to rejected.
  service.setVerification({
    id: contract.id as ULID,
    verificationStatus: 'failed',
    verificationNotes: feedback,
  });
  resolveVerificationInbox(deps.reviewInbox, contract.id);

  // Roll the WI back to in-progress, if one is linked. FD-12 — the flip + its
  // receipt land in one gateway transaction; row gone → nothing emitted.
  let updated: WorkItem | null = null;
  const rejectWi = contract.workItemId ? getWorkItem(contract.workItemId as ULID) : null;
  if (contract.workItemId && rejectWi) {
    const wiId = contract.workItemId as ULID;
    const truncated = feedback.length > 240 ? `${feedback.slice(0, 240)}…` : feedback;
    gateway.tryCommitWorkItemChange({
      projectId: rejectWi.projectId,
      mutate: () => {
        updated = applyRunOutcome(
          wiId,
          'in-progress',
          'rejected on verification — feedback wired to continuation',
          `rejected by ${actor}: ${truncated}`,
        );
        return updated ? { row: updated, reason: 'rejected' } : null;
      },
    });
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
      dispatcherSessionId,
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

/** Shared guard for contract-by-id approve + reject. Loads the contract
 *  directly by its id — no work item required. Throws `VerificationReviewError`
 *  on any precondition miss. */
function loadVerifyingContractById(contractId: ULID, service: ContractService): Contract {
  const contract = service.get(contractId);
  if (!contract) {
    throw new VerificationReviewError('wi-not-found', `contract ${contractId} not found`);
  }
  if (contract.status !== 'verifying') {
    throw new VerificationReviewError(
      'not-awaiting-verification',
      `contract ${contractId} is not awaiting verification (status: ${contract.status})`,
    );
  }
  return contract;
}

// ── Contract-by-id approve / reject ─────────────────────────────────────────
// Used when a dispatch has no linked work item (answer/payload, contract-only).
// The WI roll-up and auto-advance steps are skipped entirely; only the contract
// status is flipped and the verification receipt is written.

export interface ApproveAgentContractInput {
  contractId: ULID;
  notes?: string | null;
  actor?: 'orchestrator' | 'user';
}

/** Approve a contract-only verification hold (no linked work item). Flips the
 *  contract to `accepted`/`passed` and resolves the verification inbox card.
 *  Always returns null (no work item to roll up). */
export function approveAgentContract(
  input: ApproveAgentContractInput,
  deps: ApproveAgentWorkItemDeps = {},
): null {
  const service = deps.contractService ?? new ContractService();
  const contract = loadVerifyingContractById(input.contractId, service);
  const note = input.notes?.trim() ?? '';
  service.setVerification({
    id: contract.id as ULID,
    verificationStatus: 'passed',
    verificationNotes: note || null,
  });
  resolveVerificationInbox(deps.reviewInbox, contract.id);
  // Contract-only: no work item to roll up.
  return null;
}

export interface RejectAgentContractInput {
  contractId: ULID;
  feedback: string;
  actor?: 'orchestrator' | 'user';
  dispatcherSessionId?: string | null;
  project: Project;
}

/** Reject a contract-only verification hold. Flips the contract to
 *  `rejected`/`failed` and wakes the producer run with the feedback.
 *  Returns null for `workItem` (no WI linked), the contract, and the
 *  continuation dispatch result. */
export async function rejectAgentContract(
  input: RejectAgentContractInput,
  deps: RejectAgentWorkItemDeps,
): Promise<RejectAgentWorkItemResult> {
  const feedback = input.feedback?.trim() ?? '';
  if (!feedback) {
    throw new VerificationReviewError('feedback-required', 'feedback required for reject');
  }
  const service = deps.contractService ?? new ContractService();
  const contract = loadVerifyingContractById(input.contractId, service);
  if (!contract.agentRunId) {
    throw new VerificationReviewError(
      'no-assigned-run',
      `contract ${contract.id} has no agentRunId — was it dispatched via pc_invoke_agent?`,
    );
  }
  const actor = input.actor ?? 'orchestrator';
  const dispatcherSessionId =
    input.dispatcherSessionId?.trim() ||
    getAgentRunRow(contract.agentRunId as ULID)?.dispatcherSessionId ||
    '';
  if (!dispatcherSessionId) {
    throw new VerificationReviewError(
      'no-assigned-run',
      `contract ${contract.id}'s producer run has no dispatcher session to continue under`,
    );
  }

  // Flip the contract to rejected.
  service.setVerification({
    id: contract.id as ULID,
    verificationStatus: 'failed',
    verificationNotes: feedback,
  });
  resolveVerificationInbox(deps.reviewInbox, contract.id);

  // Contract-only: no work item to roll back.
  const continuationInput = `Reviewer rejected your previous deliverable on contract ${contract.id} with this feedback:\n\n${feedback}\n\nAddress the feedback, then re-submit your deliverable via pc_submit_deliverable before reporting done.`;

  const dispatch = deps.dispatch ?? dispatchContinueAgent;
  const continuation = await dispatch(
    {
      projectId: input.project.id,
      worktreeDir: input.project.folderPath,
      parentAgentRunId: contract.agentRunId as ULID,
      input: continuationInput,
      dispatcherSessionId,
      slug: input.project.slug,
      // No workItemId — this is a contract-only hold.
    },
    {
      ...(deps.mailboxEnqueue ? { mailboxEnqueue: deps.mailboxEnqueue } : {}),
      ...(deps.broadcast ? { broadcast: deps.broadcast } : {}),
      ...(deps.hostClient ? { hostClient: deps.hostClient } : {}),
    },
  );

  return { workItem: null, contract, continuation };
}
