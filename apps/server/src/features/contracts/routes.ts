// Slice 013 — agent-contract route adapters. Read-only this slice:
//   - GET /api/contracts/:id                  → contract detail
//   - GET /api/work-items/:id/contracts       → the work-log timeline (ordered)
//
// Contracts carry their own `projectId`, and ids are globally-unique ULIDs, so
// these are resolved directly through the ContractService (no project param in
// the path). Reads only → no live_outbox writes here (mutations ride the
// ContractService door elsewhere). ZERO broadcast/fanout (no-bypass gate).
//
// Issue 4 fix — approve + reject by contractId for contract-only holds (no WI):
//   - POST /api/contracts/:id/approve
//   - POST /api/contracts/:id/reject

import type { Hono } from 'hono';
import type { Project, ULID } from '@pc/domain';
import { ContractService } from '@pc/app-services';
import { getProjectById } from '@pc/db';

import {
  approveAgentContract,
  rejectAgentContract,
  VerificationReviewError,
} from '../../services/agent-verification-review.ts';
import type { MailboxEnqueuePort } from '../../services/agent-delivery.ts';
import type { AgentHostReattachClient } from '../../services/agent-host-reattach.ts';
import type { ReviewInboxResolution } from '../../services/dag-run-service.ts';
import type { ReviewDecisionErrorCode } from '../../services/review-decision-service.ts';
import type { dispatchContinueAgent } from '../../services/agent-run-factory.ts';
import {
  abandonContractWorkspace as defaultAbandonContractWorkspace,
  landAcceptedContract as defaultLandAcceptedContract,
} from '../../services/landing-service.ts';

/** Map a VerificationReviewError cause to an HTTP status. */
function contractDecisionStatus(code: ReviewDecisionErrorCode): 400 | 404 | 409 | 500 {
  const statusFor: Partial<Record<ReviewDecisionErrorCode, 400 | 404 | 409 | 500>> = {
    'wi-not-found': 404,
    'not-awaiting-verification': 409,
    'feedback-required': 400,
    'no-assigned-run': 409,
    'internal': 500,
  };
  return statusFor[code] ?? 400;
}

export interface ContractRoutesDeps {
  /** Defaults to a fresh ContractService (live DB). Tests may inject one. */
  contractService?: ContractService;
  /** Required for approve/reject routes — threaded into the service. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  getHostConnection?: () => AgentHostReattachClient | null;
  reviewInbox?: ReviewInboxResolution | null;
  broadcastTo?: (projectId: ULID, msg: unknown) => void;
  /** Test seam for the continuation dispatch. */
  dispatch?: typeof dispatchContinueAgent;
  /** pc-pty-chat-415 (R5) — accept ⇒ land. Test seam; production defaults to
   *  the real landing service. */
  landAcceptedContract?: typeof defaultLandAcceptedContract;
  /** pc-pty-chat-415 (R12) — explicit abandon door. Test seam. */
  abandonContractWorkspace?: typeof defaultAbandonContractWorkspace;
}

export function registerContractRoutes(app: Hono, deps: ContractRoutesDeps = {}): void {
  const service = deps.contractService ?? new ContractService();

  // Detail — the single first-class contract.
  app.get('/api/contracts/:id', (c) => {
    const id = c.req.param('id') as ULID;
    const contract = service.get(id);
    if (!contract) return c.json({ ok: false, error: `unknown contract: ${id}` }, 404);
    return c.json({ ok: true, contract });
  });

  // Work-log — every contract that rolled up to this work item, oldest-first.
  // Empty array (not 404) when the WI has no contracts — the inspector renders
  // an empty state.
  app.get('/api/work-items/:id/contracts', (c) => {
    const workItemId = c.req.param('id') as ULID;
    const contracts = service.listByWorkItem(workItemId);
    return c.json({ ok: true, contracts });
  });

  // Slice 022 — project-scoped, WI-optional contract list (newest-first).
  // Surfaces contract-only dispatches (workItemId === null) the per-WI work-log
  // can't reach. Empty array (not 404) when the project has no contracts.
  app.get('/api/projects/:id/contracts', (c) => {
    const projectId = c.req.param('id') as ULID;
    const contracts = service.listByProject(projectId);
    return c.json({ ok: true, contracts });
  });

  // Issue 4 — approve a contract-only verification hold by contractId.
  // The contract carries its own projectId; no work item is required.
  app.post('/api/contracts/:id/approve', async (c) => {
    const contractId = c.req.param('id') as ULID;
    const body = await c.req.json<{ notes?: string | null; actor?: 'orchestrator' | 'user' }>().catch(
      () => ({}) as { notes?: string | null; actor?: 'orchestrator' | 'user' },
    );
    try {
      approveAgentContract(
        {
          contractId,
          notes: typeof body.notes === 'string' ? body.notes : null,
          ...(body.actor === 'orchestrator' || body.actor === 'user' ? { actor: body.actor } : {}),
        },
        {
          contractService: service,
          reviewInbox: deps.reviewInbox,
        },
      );
      // pc-pty-chat-415 (R5) — accept ⇒ land. Best-effort: a landing failure
      // is durable on the contract, never undoes the approval.
      try {
        await (deps.landAcceptedContract ?? defaultLandAcceptedContract)(contractId, {
          contractService: service,
        });
      } catch (err) {
        console.warn(
          `[contracts] landing after approval failed for ${contractId}: ${(err as Error).message}`,
        );
      }
      return c.json({ ok: true, workItem: null });
    } catch (err) {
      if (err instanceof VerificationReviewError) {
        return c.json(
          { ok: false, error: err.message, cause: err.cause },
          contractDecisionStatus(err.cause),
        );
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // pc-pty-chat-415 (R5) — the re-land door. Re-drives landing for an ACCEPTED
  // repo contract whose landing is 'conflict' (after the human/orchestrator
  // resolved it in the engine merge worktree), 'failed', or 'pending' (crash).
  // Idempotent: an already-landed contract short-circuits to 'landed'.
  app.post('/api/contracts/:id/land', async (c) => {
    const contractId = c.req.param('id') as ULID;
    const contract = service.get(contractId);
    if (!contract) return c.json({ ok: false, error: `unknown contract: ${contractId}` }, 404);
    const landing = await (deps.landAcceptedContract ?? defaultLandAcceptedContract)(contractId, {
      contractService: service,
    });
    if (!landing.applicable) {
      return c.json({ ok: false, error: `nothing to land: ${landing.reason}` }, 409);
    }
    return c.json({ ok: landing.outcome === 'landed', landing });
  });

  // pc-pty-chat-415 (R12) — the explicit abandon door: record the unlanded
  // branch + its tip on the contract, THEN reclaim the worktree dir (the
  // branch survives as the durable artifact). Refuses while the producing run
  // is active. Idempotent: re-POST retries a failed teardown without
  // overwriting the preservation record.
  app.post('/api/contracts/:id/abandon', async (c) => {
    const contractId = c.req.param('id') as ULID;
    const contract = service.get(contractId);
    if (!contract) return c.json({ ok: false, error: `unknown contract: ${contractId}` }, 404);
    const result = await (deps.abandonContractWorkspace ?? defaultAbandonContractWorkspace)(
      contractId,
      { contractService: service },
    );
    if (!result.ok) return c.json({ ok: false, error: result.reason }, 409);
    return c.json({ ok: true, abandon: result });
  });

  // Issue 4 — reject a contract-only verification hold by contractId.
  app.post('/api/contracts/:id/reject', async (c) => {
    const contractId = c.req.param('id') as ULID;
    const body = await c.req.json<{
      feedback?: string;
      actor?: 'orchestrator' | 'user';
      dispatcherSessionId?: string;
    }>();
    const dispatcherSessionId =
      typeof body.dispatcherSessionId === 'string' ? body.dispatcherSessionId.trim() : '';
    if (!dispatcherSessionId && body.actor !== 'user') {
      return c.json(
        { ok: false, error: 'dispatcherSessionId required (orchestrator must forward PC_SESSION_ID)' },
        400,
      );
    }

    // Load the contract to resolve the project.
    const contract = service.get(contractId);
    if (!contract) {
      return c.json({ ok: false, error: `contract ${contractId} not found`, cause: 'wi-not-found' }, 404);
    }
    const project = getProjectById(contract.projectId as ULID);
    if (!project) {
      return c.json({ ok: false, error: `project ${contract.projectId} not found` }, 404);
    }

    const host = deps.getHostConnection?.() ?? null;
    try {
      const result = await rejectAgentContract(
        {
          contractId,
          feedback: typeof body.feedback === 'string' ? body.feedback : '',
          ...(body.actor === 'orchestrator' || body.actor === 'user' ? { actor: body.actor } : {}),
          dispatcherSessionId: dispatcherSessionId || null,
          project: project as Project,
        },
        {
          mailboxEnqueue: deps.mailboxEnqueue,
          broadcast: deps.broadcastTo ? (env) => deps.broadcastTo!(contract.projectId as ULID, env) : undefined,
          ...(host ? { hostClient: host } : {}),
          contractService: service,
          reviewInbox: deps.reviewInbox,
          ...(deps.dispatch ? { dispatch: deps.dispatch } : {}),
        },
      );
      return c.json({
        ok: true,
        workItem: result.workItem,
        contract: result.contract,
        continuation: result.continuation,
      });
    } catch (err) {
      if (err instanceof VerificationReviewError) {
        return c.json(
          { ok: false, error: err.message, cause: err.cause },
          contractDecisionStatus(err.cause),
        );
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });
}
