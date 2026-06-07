// Phase 1.2 (pc-pty-chat-276.3) -- Unified review-decision service.
//
// One internal entry point (applyReviewDecision) that both approve/reject doors
// delegate to. Branches on req.kind to the correct EXISTING mechanic:
//   - workflow-gate  -> applyV2ReviewDecision (loop-back mechanic, unchanged)
//   - verification-hold -> approveAgentWorkItem / rejectAgentWorkItem
//                          (continuation mechanic, unchanged)
//
// The mechanics are byte-for-byte unchanged. This layer is entry-dispatch only.
// Neither a persisted ReviewPackage store nor any new state is introduced;
// keys are the existing identifiers each mechanic already uses.

import type { Contract } from '@pc/contracts';
import type { Project, ULID, WorkItem } from '@pc/domain';
import type { RunStatus } from '@pc/workflows';
import type { ContractService } from '@pc/app-services';

import {
  applyV2ReviewDecision,
  type DagRunServiceOptions,
  type ReviewInboxResolution,
} from './dag-run-service.ts';
import {
  approveAgentWorkItem,
  rejectAgentWorkItem,
  VerificationReviewError,
} from './agent-verification-review.ts';
import type { MailboxEnqueuePort } from './agent-delivery.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';
import type { DispatchAgentResult } from './agent-run-factory.ts';
import { dispatchContinueAgent } from './agent-run-factory.ts';

// Error codes

export type ReviewDecisionErrorCode =
  | 'not-found'
  | 'not-awaiting'
  | 'instance-mismatch'
  | 'wi-not-found'
  | 'not-awaiting-verification'
  | 'feedback-required'
  | 'no-assigned-run'
  | 'internal';

// Decision shapes

export type WorkflowGateDecision =
  | { kind: 'approve' }
  | { kind: 'reject'; notes?: string };

export type VerificationDecision =
  | { kind: 'approve'; notes?: string | null; actor?: 'orchestrator' | 'user' }
  | {
      kind: 'reject';
      feedback: string;
      actor?: 'orchestrator' | 'user';
      dispatcherSessionId?: string | null;
    };

// Request shapes

export type ReviewDecisionRequest =
  | {
      kind: 'workflow-gate';
      runId: ULID;
      nodeId: string;
      decision: WorkflowGateDecision;
      instanceToken?: string;
    }
  | {
      kind: 'verification-hold';
      workItemId: ULID;
      decision: VerificationDecision;
      project: Project;
    };

// Deps shapes

export interface ReviewDecisionWorkflowDeps {
  kind: 'workflow-gate';
  dagOpts: DagRunServiceOptions;
}

export interface ReviewDecisionVerificationDeps {
  kind: 'verification-hold';
  mailboxEnqueue?: MailboxEnqueuePort | null;
  hostClient?: AgentHostReattachClient | null;
  broadcast?: (env: { type: string; [k: string]: unknown }) => void;
  contractService?: ContractService;
  reviewInbox?: ReviewInboxResolution | null;
  dispatch?: typeof dispatchContinueAgent;
}

export type ReviewDecisionDeps =
  | ReviewDecisionWorkflowDeps
  | ReviewDecisionVerificationDeps;

// Result

export type ReviewDecisionResult =
  | { ok: true; kind: 'workflow-gate'; status: RunStatus }
  | {
      ok: true;
      kind: 'verification-hold';
      workItem: WorkItem | null;
      contract?: Contract;
      continuation?: DispatchAgentResult;
    }
  | { ok: false; code: ReviewDecisionErrorCode; error: string };

// Service

export async function applyReviewDecision(
  req: ReviewDecisionRequest,
  deps: ReviewDecisionDeps,
): Promise<ReviewDecisionResult> {
  if (req.kind === 'workflow-gate') {
    if (deps.kind !== 'workflow-gate') {
      return { ok: false, code: 'internal', error: 'workflow-gate request requires workflow-gate deps' };
    }
    const wfDecision =
      req.decision.kind === 'reject'
        ? { kind: 'reject' as const, ...(req.decision.notes !== undefined ? { notes: req.decision.notes } : {}) }
        : { kind: 'approve' as const };

    const result = await applyV2ReviewDecision(
      req.runId,
      req.nodeId,
      wfDecision,
      deps.dagOpts,
      req.instanceToken,
    );

    if (!result.ok) {
      const code: ReviewDecisionErrorCode =
        result.code === 'not-found'
          ? 'not-found'
          : result.code === 'instance-mismatch'
          ? 'instance-mismatch'
          : 'not-awaiting';
      const error =
        'error' in result && typeof result.error === 'string'
          ? result.error
          : `gate "${req.nodeId}" not available`;
      return { ok: false, code, error };
    }

    return { ok: true, kind: 'workflow-gate', status: result.status };
  }

  // verification-hold
  if (deps.kind !== 'verification-hold') {
    return { ok: false, code: 'internal', error: 'verification-hold request requires verification-hold deps' };
  }

  const { workItemId, decision, project } = req;

  if (decision.kind === 'approve') {
    try {
      const workItem = approveAgentWorkItem(
        {
          workItemId,
          notes: decision.notes ?? null,
          ...(decision.actor ? { actor: decision.actor } : {}),
          project,
        },
        {
          contractService: deps.contractService,
          reviewInbox: deps.reviewInbox,
        },
      );
      return { ok: true, kind: 'verification-hold', workItem };
    } catch (err) {
      if (err instanceof VerificationReviewError) {
        return { ok: false, code: err.cause, error: err.message };
      }
      return { ok: false, code: 'internal', error: (err as Error).message };
    }
  }

  // reject
  try {
    const result = await rejectAgentWorkItem(
      {
        workItemId,
        feedback: decision.feedback,
        ...(decision.actor ? { actor: decision.actor } : {}),
        dispatcherSessionId: decision.dispatcherSessionId,
        project,
      },
      {
        mailboxEnqueue: deps.mailboxEnqueue,
        broadcast: deps.broadcast,
        hostClient: deps.hostClient,
        contractService: deps.contractService,
        reviewInbox: deps.reviewInbox,
        ...(deps.dispatch ? { dispatch: deps.dispatch } : {}),
      },
    );
    return {
      ok: true,
      kind: 'verification-hold',
      workItem: result.workItem,
      contract: result.contract,
      continuation: result.continuation,
    };
  } catch (err) {
    if (err instanceof VerificationReviewError) {
      return { ok: false, code: err.cause, error: err.message };
    }
    return { ok: false, code: 'internal', error: (err as Error).message };
  }
}
