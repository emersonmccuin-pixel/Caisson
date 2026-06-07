// Agent-contract family (slice 013). Browser-safe, zero runtime deps.
//
// Boundary purity (slices 001–006): no imports from apps, @pc/db, @pc/domain.
// The v2 `ExpectedOutput` / `Deliverable` / acceptance-predicate union is
// MIRRORED here from `@pc/domain/src/contract.ts` (the same way `pending-asks.ts`
// mirrors `PendingAskRow`) so the browser bundle never reaches into @pc/domain.
//
// Owns:
//   - the `Contract` DTO (the first-class agent contract — a machine assignment
//     with a typed, verified output; optionally linked to one work item),
//   - the v2 union types (ExpectedOutput / Deliverable / AcceptancePredicate),
//   - request parsers,
//   - the canonical `contract.changed` live-event payload + parser/guards.
//
// Contract events are PROJECT-scoped. `version` carries `agent_contracts.version`
// for rev-aware upserts. Mirrors the helper trio (is*/parse*) in areas.ts.

import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
  type LiveEventFrame,
} from './live-events.ts';
import type { ULID } from './shared.ts';

// ── v2 union (mirror of @pc/domain contract.ts) ──────────────────────────────

export const VERIFICATION_TIERS = ['auto', 'orchestrator-review', 'human-review'] as const;
export type VerificationTier = (typeof VERIFICATION_TIERS)[number];

export const VERIFICATION_STATUSES = ['pending', 'passed', 'failed'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const DELIVERABLE_KINDS = [
  'answer',
  'prose',
  'payload',
  'repo',
  'external',
  'binary',
  'action',
] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  [k: string]: unknown;
};

export type ProseDocType =
  | 'plan'
  | 'prd'
  | 'research'
  | 'design'
  | 'adr'
  | 'spec'
  | 'runbook'
  | 'summary'
  | 'postmortem'
  | 'note';
// M5 (FD-5) — ☠ 'work_item_body' (body = brief only; mirror of domain's ProseStore).
export type ProseStore = 'contract' | 'attachment' | 'repo_file';
export type PayloadSemantic =
  | 'extraction'
  | 'classification'
  | 'decision'
  | 'verdict'
  | 'decomposition'
  | 'score';
export type RepoCheck =
  | { preset: 'build' | 'test' | 'lint' }
  | { command: string; cwd?: 'worktree' | 'project' };
export type BinaryArtifactType = 'diagram' | 'screenshot' | 'export' | 'dataset' | 'build';
export const EXTERNAL_SYSTEMS = ['email', 'calendar', 'chat', 'ticket', 'crm', 'api'] as const;
export type ExternalSystem = (typeof EXTERNAL_SYSTEMS)[number];

export type ExpectedOutput =
  | { kind: 'answer'; must_address?: string[]; min_chars?: number }
  | {
      kind: 'prose';
      doc_type?: ProseDocType;
      sections?: string[];
      min_chars?: number;
      store?: ProseStore;
      path?: string;
    }
  | { kind: 'payload'; schema: JsonSchema; semantic?: PayloadSemantic }
  | {
      kind: 'repo';
      isolation: 'worktree' | 'in_place';
      paths_touched?: string[];
      checks?: RepoCheck[];
      require_diff?: boolean;
    }
  | {
      kind: 'external';
      system: ExternalSystem;
      action: string;
      confirm: 'always' | 'pre-authorized';
      idempotency_key: string;
      verify_handle?: boolean;
    }
  | { kind: 'binary'; artifact_type?: BinaryArtifactType; mime?: string; min_size_bytes?: number }
  | { kind: 'action'; tool: string; min_count?: number; before_end_turn?: boolean };

export const EXPECTED_OUTPUT_KINDS = [
  'answer',
  'prose',
  'payload',
  'repo',
  'external',
  'binary',
  'action',
] as const;
export type ExpectedOutputKind = (typeof EXPECTED_OUTPUT_KINDS)[number];

export type Deliverable =
  | { kind: 'answer'; text: string }
  | { kind: 'prose'; text?: string; attachmentId?: string; ref?: string }
  | { kind: 'payload'; data: unknown }
  | {
      kind: 'repo';
      branch?: string;
      commit?: string;
      diffStat?: { files: number; insertions: number; deletions: number };
      prUrl?: string;
    }
  | { kind: 'external'; system: ExternalSystem; handle: string; idempotencyKey: string; url?: string }
  | { kind: 'binary'; attachmentId: string; mime: string; bytes: number }
  | { kind: 'action'; tool: string; count: number };

/** Canonical "deliverable → readable text" projection. `answer`/`prose` carry
 *  their text inline; every other (structured) kind has no prose body, so the
 *  contract's free-text `report` is surfaced instead. This is the ONE place that
 *  decides what a submitted deliverable "reads as" — the terminal envelope
 *  (agent completion) and the workflow `$node.output` resolver both call it so
 *  they can never diverge. Returns '' when there is nothing to show. */
export function contractDeliverableText(
  deliverable: Deliverable | null | undefined,
  report?: string | null,
): string {
  if (deliverable && (deliverable.kind === 'answer' || deliverable.kind === 'prose')) {
    return deliverable.text ?? '';
  }
  return report ?? '';
}

export type AcceptancePredicate =
  | { kind: 'files_exist'; paths: string[]; min_size_bytes?: number }
  | { kind: 'fields_populated'; keys: string[] }
  | { kind: 'field_matches'; key: string; pattern: string }
  | { kind: 'bash_exit_zero'; command: string; cwd?: 'worktree' | 'project' }
  | { kind: 'attachments_present'; names: string[] }
  | { kind: 'body_contains'; pattern: string; regex?: boolean }
  | { kind: 'child_work_items_done'; count?: number; all?: boolean }
  | { kind: 'schema_valid'; schema: JsonSchema }
  | { kind: 'git_diff_nonempty'; cwd?: 'worktree' | 'project' }
  | { kind: 'external_handle_present' }
  | { kind: 'tool_called'; name: string; min_count?: number }
  | { kind: 'pending_ask_created' }
  | { kind: 'report_contains'; pattern: string; regex?: boolean }
  | { kind: 'min_length'; min: number };

export type AcceptanceCriteria = AcceptancePredicate[];

export const CONTRACT_STATUSES = [
  'issued',
  'dispatched',
  'submitted',
  'verifying',
  'accepted',
  'rejected',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

// ── Contract DTO ─────────────────────────────────────────────────────────────

/** The first-class agent contract. A machine assignment with a typed output.
 *  Optionally rolls up to one work item (the work-log). Many contracts may link
 *  to one work item (1:many); the FK is nullable. */
export interface Contract {
  id: ULID;
  projectId: ULID;
  /** Optional, one-to-many. Null = a contract with no human work item. */
  workItemId: ULID | null;
  /** The producing run. Null until dispatched. */
  agentRunId: ULID | null;
  podName: string | null;
  /** The typed spec the orchestrator authored. */
  expectedOutput: ExpectedOutput | null;
  /** Derived predicate set. Empty array = no auto-checks. */
  acceptanceCriteria: AcceptanceCriteria | null;
  verificationTier: VerificationTier | null;
  verificationStatus: VerificationStatus | null;
  verificationNotes: string | null;
  /** Free text to the orchestrator. Always present once the run reports. */
  report: string | null;
  /** The typed, captured artifact — owned HERE, not borrowed from wi.body. */
  deliverable: Deliverable | null;
  /** Isolation axis for repo/file producers. */
  worktreePath: string | null;
  status: ContractStatus;
  /** Optimistic-concurrency counter. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

// ── Request schemas ──────────────────────────────────────────────────────────

export const contractRoutes = {
  detail: (id: ULID) => `/api/contracts/${encodeURIComponent(id)}`,
  forWorkItem: (workItemId: ULID) =>
    `/api/work-items/${encodeURIComponent(workItemId)}/contracts`,
  /** Slice 022 — project-scoped, WI-optional contract list (surfaces
   *  contract-only dispatches the per-WI work-log can't reach). */
  forProject: (projectId: ULID) =>
    `/api/projects/${encodeURIComponent(projectId)}/contracts`,
} as const;

export interface ListContractsResponse {
  ok: true;
  contracts: Contract[];
}

export interface ContractDetailResponse {
  ok: true;
  contract: Contract;
}

// ── Live-event contract ──────────────────────────────────────────────────────

export type ContractMutationReason =
  | 'created'
  | 'dispatched'
  | 'deliverable-set'
  | 'verification-set'
  | 'patched';

export interface ContractChangedLivePayload {
  reason: ContractMutationReason;
  contract: Contract;
}

export type ContractChangedLiveEvent = LiveEvent<ContractChangedLivePayload> & {
  type: 'contract.changed';
  entity: 'contract';
  scope: 'project';
  projectId: ULID;
};

export type ContractChangedLiveEventFrame = LiveEventFrame<ContractChangedLivePayload> & {
  event: ContractChangedLiveEvent;
};

// ── Guards ────────────────────────────────────────────────────────────────────

export function isVerificationTier(value: unknown): value is VerificationTier {
  return typeof value === 'string' && (VERIFICATION_TIERS as readonly string[]).includes(value);
}

export function isVerificationStatus(value: unknown): value is VerificationStatus {
  return typeof value === 'string' && (VERIFICATION_STATUSES as readonly string[]).includes(value);
}

export function isDeliverableKind(value: unknown): value is DeliverableKind {
  return typeof value === 'string' && (DELIVERABLE_KINDS as readonly string[]).includes(value);
}

export function isExpectedOutputKind(value: unknown): value is ExpectedOutputKind {
  return typeof value === 'string' && (EXPECTED_OUTPUT_KINDS as readonly string[]).includes(value);
}

export function isContractStatus(value: unknown): value is ContractStatus {
  return typeof value === 'string' && (CONTRACT_STATUSES as readonly string[]).includes(value);
}

export function isContractMutationReason(value: unknown): value is ContractMutationReason {
  return (
    value === 'created' ||
    value === 'dispatched' ||
    value === 'deliverable-set' ||
    value === 'verification-set' ||
    value === 'patched'
  );
}

export function isContract(value: unknown): value is Contract {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    (value.workItemId === null || typeof value.workItemId === 'string') &&
    (value.agentRunId === null || typeof value.agentRunId === 'string') &&
    (value.podName === null || typeof value.podName === 'string') &&
    (value.expectedOutput === null || isRecord(value.expectedOutput)) &&
    (value.acceptanceCriteria === null || Array.isArray(value.acceptanceCriteria)) &&
    (value.verificationTier === null || isVerificationTier(value.verificationTier)) &&
    (value.verificationStatus === null || isVerificationStatus(value.verificationStatus)) &&
    (value.verificationNotes === null || typeof value.verificationNotes === 'string') &&
    (value.report === null || typeof value.report === 'string') &&
    (value.deliverable === null || isRecord(value.deliverable)) &&
    (value.worktreePath === null || typeof value.worktreePath === 'string') &&
    isContractStatus(value.status) &&
    typeof value.version === 'number' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

export function isContractChangedLivePayload(
  value: unknown,
): value is ContractChangedLivePayload {
  if (!isRecord(value) || !isContractMutationReason(value.reason)) return false;
  return isContract(value.contract);
}

export function isContractChangedLiveEvent(value: unknown): value is ContractChangedLiveEvent {
  return (
    isLiveEvent(value) &&
    value.type === 'contract.changed' &&
    value.entity === 'contract' &&
    value.scope === 'project' &&
    typeof value.projectId === 'string' &&
    isContractChangedLivePayload(value.payload)
  );
}

export function isContractChangedLiveEventFrame(
  value: unknown,
): value is ContractChangedLiveEventFrame {
  return isLiveEventFrame(value) && isContractChangedLiveEvent(value.event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
