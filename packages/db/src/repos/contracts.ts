// Slice 013 — agent_contracts repo. Persistence-only (no outbox writes — the
// app-services ContractService announces). Mirrors repos/areas.ts: DbExecutor-
// injectable `*InDb` variants + getDb() wrappers.
//
// A contract is a first-class agent assignment with a typed, verified output.
// Optionally links to one work item (1:many). The deliverable lives here.

import { asc, desc, eq } from 'drizzle-orm';
import type {
  AcceptanceCriteria,
  ContractLandingStatus,
  ContractStatus,
  ContractV2,
  Deliverable,
  ULID,
  VerificationStatus,
  VerificationTier,
} from '@pc/domain';
import { getDb } from '../connection.ts';
import type { DbExecutor } from '../connection.ts';
import { newId } from '../id.ts';
import { agentContracts } from '../schema.ts';

export interface ContractRow {
  id: ULID;
  projectId: ULID;
  workItemId: ULID | null;
  agentRunId: ULID | null;
  podName: string | null;
  expectedOutput: ContractV2.ExpectedOutput | null;
  acceptanceCriteria: AcceptanceCriteria | null;
  verificationTier: VerificationTier | null;
  verificationStatus: VerificationStatus | null;
  verificationNotes: string | null;
  report: string | null;
  deliverable: Deliverable | null;
  worktreePath: string | null;
  /** pc-pty-chat-415 (R5) — accept ⇒ land. Null = not applicable. */
  landingStatus: ContractLandingStatus | null;
  landedBranch: string | null;
  landedSha: string | null;
  landingError: string | null;
  landedAt: number | null;
  status: ContractStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateContractInput {
  id?: ULID;
  projectId: ULID;
  workItemId?: ULID | null;
  agentRunId?: ULID | null;
  podName?: string | null;
  expectedOutput?: ContractV2.ExpectedOutput | null;
  acceptanceCriteria?: AcceptanceCriteria | null;
  verificationTier?: VerificationTier | null;
  report?: string | null;
  worktreePath?: string | null;
  status?: ContractStatus;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export function getContract(id: ULID): ContractRow | null {
  return getContractInDb(getDb(), id);
}

export function getContractInDb(db: DbExecutor, id: ULID): ContractRow | null {
  const row = db.select().from(agentContracts).where(eq(agentContracts.id, id)).get() as
    | ContractRow
    | undefined;
  return row ?? null;
}

/** All contracts for one work item — the work-log timeline. Oldest first
 *  (created order) so the timeline reads top-to-bottom. */
export function listContractsForWorkItem(workItemId: ULID): ContractRow[] {
  return listContractsForWorkItemInDb(getDb(), workItemId);
}

export function listContractsForWorkItemInDb(db: DbExecutor, workItemId: ULID): ContractRow[] {
  return db
    .select()
    .from(agentContracts)
    .where(eq(agentContracts.workItemId, workItemId))
    .orderBy(asc(agentContracts.createdAt), asc(agentContracts.id))
    .all() as ContractRow[];
}

/** All contracts produced by one agent run. Newest first. */
export function listContractsForRun(agentRunId: ULID): ContractRow[] {
  return listContractsForRunInDb(getDb(), agentRunId);
}

export function listContractsForRunInDb(db: DbExecutor, agentRunId: ULID): ContractRow[] {
  return db
    .select()
    .from(agentContracts)
    .where(eq(agentContracts.agentRunId, agentRunId))
    .orderBy(desc(agentContracts.createdAt), desc(agentContracts.id))
    .all() as ContractRow[];
}

/** All contracts in one project, newest first — the project-scoped contract
 *  list. Surfaces WI-optional dispatches (contracts with workItemId === null)
 *  that the work-log timeline can't reach. */
export function listContractsForProject(projectId: ULID): ContractRow[] {
  return listContractsForProjectInDb(getDb(), projectId);
}

export function listContractsForProjectInDb(db: DbExecutor, projectId: ULID): ContractRow[] {
  return db
    .select()
    .from(agentContracts)
    .where(eq(agentContracts.projectId, projectId))
    .orderBy(desc(agentContracts.createdAt), desc(agentContracts.id))
    .all() as ContractRow[];
}

// ── Writes ──────────────────────────────────────────────────────────────────

export function createContract(input: CreateContractInput): ContractRow {
  return createContractInDb(getDb(), input);
}

export function createContractInDb(db: DbExecutor, input: CreateContractInput): ContractRow {
  const now = Date.now();
  const id = input.id ?? (newId() as ULID);
  const row: ContractRow = {
    id,
    projectId: input.projectId,
    workItemId: input.workItemId ?? null,
    agentRunId: input.agentRunId ?? null,
    podName: input.podName ?? null,
    expectedOutput: input.expectedOutput ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? null,
    verificationTier: input.verificationTier ?? null,
    verificationStatus: null,
    verificationNotes: null,
    report: input.report ?? null,
    deliverable: null,
    worktreePath: input.worktreePath ?? null,
    landingStatus: null,
    landedBranch: null,
    landedSha: null,
    landingError: null,
    landedAt: null,
    status: input.status ?? 'issued',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(agentContracts).values(row).run();
  return row;
}

/** Point the contract at its producing run + flip to `dispatched`. Bumps
 *  version. Returns the updated row, or null if the contract is gone. */
export function setContractRun(
  id: ULID,
  agentRunId: ULID,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const existing = getContractInDb(db, id);
  if (!existing) return null;
  db.update(agentContracts)
    .set({
      agentRunId,
      status: 'dispatched',
      version: existing.version + 1,
      updatedAt: Date.now(),
    })
    .where(eq(agentContracts.id, id))
    .run();
  return getContractInDb(db, id);
}

export interface SetDeliverableInput {
  deliverable: Deliverable | null;
  report?: string | null;
  /** Optional status override (default 'submitted'). */
  status?: ContractStatus;
}

/** Write the captured deliverable (+ optional report) onto the contract. Bumps
 *  version. Returns the updated row, or null if the contract is gone. */
export function setContractDeliverable(
  id: ULID,
  input: SetDeliverableInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const existing = getContractInDb(db, id);
  if (!existing) return null;
  const patch: Partial<ContractRow> = {
    deliverable: input.deliverable,
    status: input.status ?? 'submitted',
    version: existing.version + 1,
    updatedAt: Date.now(),
  };
  if (input.report !== undefined) patch.report = input.report;
  db.update(agentContracts).set(patch).where(eq(agentContracts.id, id)).run();
  return getContractInDb(db, id);
}

export interface SetVerificationInput {
  verificationStatus: VerificationStatus;
  verificationNotes?: string | null;
  verificationTier?: VerificationTier;
  status?: ContractStatus;
}

export interface SetLandingInput {
  landingStatus: ContractLandingStatus;
  landedBranch?: string | null;
  landedSha?: string | null;
  landingError?: string | null;
  landedAt?: number | null;
}

/** pc-pty-chat-415 (R5) — record the landing state/receipts onto the contract.
 *  Bumps version. Returns the updated row, or null if the contract is gone. */
export function setContractLanding(
  id: ULID,
  input: SetLandingInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const existing = getContractInDb(db, id);
  if (!existing) return null;
  const patch: Partial<ContractRow> = {
    landingStatus: input.landingStatus,
    version: existing.version + 1,
    updatedAt: Date.now(),
  };
  if (input.landedBranch !== undefined) patch.landedBranch = input.landedBranch;
  if (input.landedSha !== undefined) patch.landedSha = input.landedSha;
  if (input.landingError !== undefined) patch.landingError = input.landingError;
  if (input.landedAt !== undefined) patch.landedAt = input.landedAt;
  db.update(agentContracts).set(patch).where(eq(agentContracts.id, id)).run();
  return getContractInDb(db, id);
}

/** pc-pty-chat-415 (R5) — landings interrupted mid-flight (status 'pending'),
 *  re-driven at boot. The landing mechanics are idempotent, so a crash between
 *  merge and push (or push and receipt) converges on re-drive. */
export function listContractsPendingLanding(db: DbExecutor = getDb()): ContractRow[] {
  return db
    .select()
    .from(agentContracts)
    .where(eq(agentContracts.landingStatus, 'pending'))
    .orderBy(asc(agentContracts.updatedAt))
    .all() as ContractRow[];
}

/** Record the verification outcome onto the contract. Bumps version. Returns
 *  the updated row, or null if the contract is gone. */
export function setContractVerification(
  id: ULID,
  input: SetVerificationInput,
  db: DbExecutor = getDb(),
): ContractRow | null {
  const existing = getContractInDb(db, id);
  if (!existing) return null;
  const patch: Partial<ContractRow> = {
    verificationStatus: input.verificationStatus,
    version: existing.version + 1,
    updatedAt: Date.now(),
  };
  if (input.verificationNotes !== undefined) patch.verificationNotes = input.verificationNotes;
  if (input.verificationTier !== undefined) patch.verificationTier = input.verificationTier;
  patch.status =
    input.status ??
    (input.verificationStatus === 'passed'
      ? 'accepted'
      : input.verificationStatus === 'failed'
        ? 'rejected'
        : 'verifying');
  db.update(agentContracts).set(patch).where(eq(agentContracts.id, id)).run();
  return getContractInDb(db, id);
}
