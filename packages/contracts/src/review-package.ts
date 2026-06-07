// ReviewPackage envelope -- Phase 0.1 (pc-pty-chat-276.1).
// Unified shape for all review/approval items across three producers:
// agent-verification, workflow-gate, orchestrator-adhoc.
//
// ADDITIVE only: no producers wired, no existing callers changed.
// Browser-safe; zero runtime deps beyond shared.ts.

import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

// ---- Owner & producer -------------------------------------------------------

/** Who is responsible for deciding this review. */
export type ReviewOwner = 'human' | 'orchestrator';

/** Which part of the system created this package. */
export type ReviewProducer = 'agent-verification' | 'workflow-gate' | 'orchestrator-adhoc';

export const REVIEW_PRODUCERS = [
  'agent-verification',
  'workflow-gate',
  'orchestrator-adhoc',
] as const satisfies readonly ReviewProducer[];

export const REVIEW_OWNERS = ['human', 'orchestrator'] as const satisfies readonly ReviewOwner[];

// ---- Work body (what the reviewer sees) -------------------------------------

export type ReviewWorkKind = 'prose' | 'code-diff' | 'plan' | 'payload';

export interface ReviewWorkProse {
  kind: 'prose';
  text: string;
}

export interface ReviewWorkCodeDiff {
  kind: 'code-diff';
  diff: string;
  files?: string[];
}

export interface ReviewWorkPlan {
  kind: 'plan';
  steps: string[];
}

export interface ReviewWorkPayload {
  kind: 'payload';
  data: Record<string, unknown>;
  schema?: Record<string, unknown>;
}

export type ReviewWork =
  | ReviewWorkProse
  | ReviewWorkCodeDiff
  | ReviewWorkPlan
  | ReviewWorkPayload;

export const REVIEW_WORK_KINDS = [
  'prose',
  'code-diff',
  'plan',
  'payload',
] as const satisfies readonly ReviewWorkKind[];

// ---- Provenance -------------------------------------------------------------

export interface ReviewProvenance {
  /** Agent run that produced this package (null for orchestrator ad-hoc). */
  agentRunId: ULID | null;
  /** Work item the agent or gate was operating on (null when not applicable). */
  workItemId: ULID | null;
  /** Workflow node id that raised this gate (null for non-workflow sources). */
  workflowNodeId: string | null;
  /** Unix ms timestamp when this package was filed. */
  dispatchedAt: number;
}

// ---- Attempt history --------------------------------------------------------

export type ReviewDecision = 'approved' | 'changes-requested';

/** One round-trip: work submitted, decision recorded, optional feedback before
 *  the next attempt. The last entry is the current attempt (decision absent
 *  if still pending). */
export interface ReviewAttempt {
  attempt: number;
  submittedAt: number;
  decision?: ReviewDecision | null;
  /** Feedback provided alongside a changes-requested decision. */
  feedback?: string | null;
}

// ---- Available actions ------------------------------------------------------

export type ReviewAction = 'approve' | 'request-changes' | 'discuss';

export const REVIEW_ACTIONS = [
  'approve',
  'request-changes',
  'discuss',
] as const satisfies readonly ReviewAction[];

// ---- The envelope -----------------------------------------------------------

export interface ReviewPackage {
  /** Stable identity for this review item across attempts. */
  id: ULID;
  producer: ReviewProducer;
  owner: ReviewOwner;
  /** Short title shown in the inbox rail. */
  title: string;
  /** The brief as dispatched -- what was asked. */
  whatWasAsked: string;
  /** Human-readable statement of what done means. */
  acceptanceCriteria: string;
  /** The work to review -- typed by kind so the UI renders it appropriately. */
  work: ReviewWork;
  provenance: ReviewProvenance;
  /** All attempts so far; last entry is current. Empty on first dispatch. */
  attemptHistory: ReviewAttempt[];
  /** Actions the current owner may take. */
  availableActions: ReviewAction[];
}

// ---- Guards -----------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function isReviewProducer(v: unknown): v is ReviewProducer {
  return typeof v === 'string' && (REVIEW_PRODUCERS as readonly string[]).includes(v);
}

export function isReviewOwner(v: unknown): v is ReviewOwner {
  return typeof v === 'string' && (REVIEW_OWNERS as readonly string[]).includes(v);
}

export function isReviewWorkKind(v: unknown): v is ReviewWorkKind {
  return typeof v === 'string' && (REVIEW_WORK_KINDS as readonly string[]).includes(v);
}

export function isReviewAction(v: unknown): v is ReviewAction {
  return typeof v === 'string' && (REVIEW_ACTIONS as readonly string[]).includes(v);
}

export function isReviewWork(v: unknown): v is ReviewWork {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case 'prose':
      return typeof v.text === 'string';
    case 'code-diff':
      return (
        typeof v.diff === 'string' &&
        (v.files === undefined ||
          (Array.isArray(v.files) && (v.files as unknown[]).every((f) => typeof f === 'string')))
      );
    case 'plan':
      return (
        Array.isArray(v.steps) &&
        (v.steps as unknown[]).every((s) => typeof s === 'string')
      );
    case 'payload':
      return isRecord(v.data) && (v.schema === undefined || isRecord(v.schema));
    default:
      return false;
  }
}

export function isReviewProvenance(v: unknown): v is ReviewProvenance {
  if (!isRecord(v)) return false;
  return (
    (v.agentRunId === null || typeof v.agentRunId === 'string') &&
    (v.workItemId === null || typeof v.workItemId === 'string') &&
    (v.workflowNodeId === null || typeof v.workflowNodeId === 'string') &&
    typeof v.dispatchedAt === 'number'
  );
}

export function isReviewAttempt(v: unknown): v is ReviewAttempt {
  if (!isRecord(v)) return false;
  return (
    typeof v.attempt === 'number' &&
    typeof v.submittedAt === 'number' &&
    (v.decision === undefined ||
      v.decision === null ||
      v.decision === 'approved' ||
      v.decision === 'changes-requested') &&
    (v.feedback === undefined || v.feedback === null || typeof v.feedback === 'string')
  );
}

export function isReviewPackage(v: unknown): v is ReviewPackage {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyString(v.id) &&
    isReviewProducer(v.producer) &&
    isReviewOwner(v.owner) &&
    isNonEmptyString(v.title) &&
    typeof v.whatWasAsked === 'string' &&
    typeof v.acceptanceCriteria === 'string' &&
    isReviewWork(v.work) &&
    isReviewProvenance(v.provenance) &&
    Array.isArray(v.attemptHistory) &&
    (v.attemptHistory as unknown[]).every(isReviewAttempt) &&
    Array.isArray(v.availableActions) &&
    (v.availableActions as unknown[]).every(isReviewAction)
  );
}

// ---- Parser -----------------------------------------------------------------

export function parseReviewPackage(input: unknown): ParseResult<ReviewPackage> {
  if (!isRecord(input)) return parseErr('review package must be an object');
  if (!isNonEmptyString(input.id)) return parseErr('id required');
  if (!isReviewProducer(input.producer)) return parseErr('producer invalid');
  if (!isReviewOwner(input.owner)) return parseErr('owner invalid');
  if (!isNonEmptyString(input.title)) return parseErr('title required');
  if (typeof input.whatWasAsked !== 'string') return parseErr('whatWasAsked must be a string');
  if (typeof input.acceptanceCriteria !== 'string') {
    return parseErr('acceptanceCriteria must be a string');
  }
  if (!isReviewWork(input.work)) return parseErr('work invalid or missing');
  if (!isReviewProvenance(input.provenance)) return parseErr('provenance invalid or missing');
  if (!Array.isArray(input.attemptHistory)) return parseErr('attemptHistory must be an array');
  for (const a of input.attemptHistory as unknown[]) {
    if (!isReviewAttempt(a)) return parseErr('attemptHistory contains an invalid attempt');
  }
  if (!Array.isArray(input.availableActions)) return parseErr('availableActions must be an array');
  for (const a of input.availableActions as unknown[]) {
    if (!isReviewAction(a)) return parseErr('availableActions contains invalid action: ' + String(a));
  }
  return parseOk(input as unknown as ReviewPackage);
}

// ---- Constructor ------------------------------------------------------------

/** Build a ReviewPackage, defaulting attemptHistory and availableActions. */
export function makeReviewPackage(
  fields: Omit<ReviewPackage, 'attemptHistory' | 'availableActions'> & {
    attemptHistory?: ReviewAttempt[];
    availableActions?: ReviewAction[];
  },
): ReviewPackage {
  return {
    ...fields,
    attemptHistory: fields.attemptHistory ?? [],
    availableActions: fields.availableActions ?? ['approve', 'request-changes', 'discuss'],
  };
}
