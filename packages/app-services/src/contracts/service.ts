// Contract service (slice 013) — the durable write door for agent contracts.
//
// Mirrors the AreaService: each mutation runs the repo write +
// `insertLiveEvent(tx, draft)` a `contract.changed` row in the SAME transaction.
// The live-relay drains the committed row and fans the canonical frame by scope
// ('project') — fully automatic. No broadcast / fanout here.
//
// Boundary purity: imports only @pc/contracts, @pc/db, @pc/domain.

import type {
  Contract,
  ContractChangedLivePayload,
  ContractMutationReason,
  Deliverable,
  ExpectedOutput as ContractExpectedOutput,
  ULID,
  VerificationStatus,
  VerificationTier,
} from '@pc/contracts';
import {
  createContractInDb,
  getContractInDb,
  getDb,
  insertLiveEvent,
  listContractsForProjectInDb,
  listContractsForRunInDb,
  listContractsForWorkItemInDb,
  setContractDeliverable as setContractDeliverableInDb,
  setContractRun as setContractRunInDb,
  setContractVerification as setContractVerificationInDb,
  type ContractRow,
  type DbExecutor,
  type InsertLiveEventDraft,
} from '@pc/db';
import type { AcceptanceCriteria, ContractV2, ULID as DomainULID } from '@pc/domain';

export function toContractDto(row: ContractRow): Contract {
  return {
    id: row.id,
    projectId: row.projectId,
    workItemId: row.workItemId,
    agentRunId: row.agentRunId,
    podName: row.podName,
    // The repo persists the v2 union; the DTO mirror is structurally identical.
    expectedOutput: (row.expectedOutput as ContractExpectedOutput | null) ?? null,
    acceptanceCriteria: (row.acceptanceCriteria as Contract['acceptanceCriteria']) ?? null,
    verificationTier: row.verificationTier,
    verificationStatus: row.verificationStatus,
    verificationNotes: row.verificationNotes,
    report: row.report,
    deliverable: row.deliverable,
    worktreePath: row.worktreePath,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Build the canonical `contract.changed` outbox draft. Project-scoped; carries
 *  the full contract DTO + its version. */
export function buildContractChangedDraft(input: {
  reason: ContractMutationReason;
  contract: Contract;
}): InsertLiveEventDraft<ContractChangedLivePayload> {
  return {
    scope: 'project',
    projectId: input.contract.projectId as DomainULID,
    type: 'contract.changed',
    entity: 'contract',
    entityId: input.contract.id as DomainULID,
    version: input.contract.version,
    payload: { reason: input.reason, contract: input.contract },
  };
}

export interface ContractServiceDeps {
  transaction?: <T>(fn: (tx: DbExecutor) => T) => T;
  insertLiveEvent?: typeof insertLiveEvent;
}

export interface CreateContractServiceInput {
  projectId: ULID;
  workItemId?: ULID | null;
  agentRunId?: ULID | null;
  podName?: string | null;
  expectedOutput?: ContractV2.ExpectedOutput | null;
  acceptanceCriteria?: AcceptanceCriteria | null;
  verificationTier?: VerificationTier | null;
  worktreePath?: string | null;
}

export class ContractService {
  private readonly tx: <T>(fn: (tx: DbExecutor) => T) => T;
  private readonly insert: typeof insertLiveEvent;

  constructor(deps: ContractServiceDeps = {}) {
    this.tx = deps.transaction ?? ((fn) => getDb().transaction(fn));
    this.insert = deps.insertLiveEvent ?? insertLiveEvent;
  }

  /** Read-only point fetch. No event. */
  get(id: ULID): Contract | null {
    const row = getContractInDb(getDb(), id as DomainULID);
    return row ? toContractDto(row) : null;
  }

  /** Read-only — the work-log timeline (oldest-first). No event. */
  listByWorkItem(workItemId: ULID): Contract[] {
    return listContractsForWorkItemInDb(getDb(), workItemId as DomainULID).map(toContractDto);
  }

  /** Read-only — contracts produced by one run (newest-first). No event. */
  listByRun(agentRunId: ULID): Contract[] {
    return listContractsForRunInDb(getDb(), agentRunId as DomainULID).map(toContractDto);
  }

  /** Read-only — every contract in a project (newest-first), including
   *  WI-optional (workItemId === null) dispatches the work-log can't reach.
   *  No event. */
  listByProject(projectId: ULID): Contract[] {
    return listContractsForProjectInDb(getDb(), projectId as DomainULID).map(toContractDto);
  }

  create(input: CreateContractServiceInput): Contract {
    return this.tx((tx) => {
      const row = createContractInDb(tx, {
        projectId: input.projectId as DomainULID,
        workItemId: (input.workItemId ?? null) as DomainULID | null,
        agentRunId: (input.agentRunId ?? null) as DomainULID | null,
        ...(input.podName !== undefined ? { podName: input.podName } : {}),
        ...(input.expectedOutput !== undefined ? { expectedOutput: input.expectedOutput } : {}),
        ...(input.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: input.acceptanceCriteria }
          : {}),
        ...(input.verificationTier !== undefined
          ? { verificationTier: input.verificationTier }
          : {}),
        ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
      });
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'created', contract }));
      return contract;
    });
  }

  /** Point the contract at its producing run + flip to `dispatched`. Returns
   *  null when the contract is gone. */
  setRun(id: ULID, agentRunId: ULID): Contract | null {
    return this.tx((tx) => {
      const row = setContractRunInDb(id as DomainULID, agentRunId as DomainULID, tx);
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'dispatched', contract }));
      return contract;
    });
  }

  /** Write the captured deliverable (+ optional report) onto the contract. */
  setDeliverable(input: {
    id: ULID;
    deliverable: Deliverable | null;
    report?: string | null;
  }): Contract | null {
    return this.tx((tx) => {
      const row = setContractDeliverableInDb(
        input.id as DomainULID,
        {
          deliverable: input.deliverable,
          ...(input.report !== undefined ? { report: input.report } : {}),
        },
        tx,
      );
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'deliverable-set', contract }));
      return contract;
    });
  }

  /** Record the verification outcome onto the contract. */
  setVerification(input: {
    id: ULID;
    verificationStatus: VerificationStatus;
    verificationNotes?: string | null;
    verificationTier?: VerificationTier;
  }): Contract | null {
    return this.tx((tx) => {
      const row = setContractVerificationInDb(
        input.id as DomainULID,
        {
          verificationStatus: input.verificationStatus,
          ...(input.verificationNotes !== undefined
            ? { verificationNotes: input.verificationNotes }
            : {}),
          ...(input.verificationTier !== undefined
            ? { verificationTier: input.verificationTier }
            : {}),
        },
        tx,
      );
      if (!row) return null;
      const contract = toContractDto(row);
      this.insert(tx, buildContractChangedDraft({ reason: 'verification-set', contract }));
      return contract;
    });
  }
}
