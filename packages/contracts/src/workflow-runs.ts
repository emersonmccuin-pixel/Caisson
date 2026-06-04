// Workflow run / review contract family (slice 004). Browser-safe, zero runtime deps.
//
// Owns `WorkflowRunDto`, `WorkflowDagStateDto` (browser-safe mirror of
// WorkflowV2.WorkflowDagState), `WorkflowReviewDecision`, fire/review request
// schemas, and the canonical `workflow.run.changed` / `workflow.review.changed`
// live-event payloads + guards. Run/review events are PROJECT-scoped; `version`
// carries `workflow_runs_v2.rev` for rev-aware upserts. Mirrors the helper trio
// (build*/is*/to*) in work-items.ts.

import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
  type LiveEventFrame,
} from './live-events.ts';
import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

// Mirrors WorkflowV2.WorkflowRunStatus.
export const WORKFLOW_RUN_STATUSES = [
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

// Mirrors WorkflowV2.NodeRunState.
export const WORKFLOW_NODE_RUN_STATES = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'awaiting-review',
] as const;
export type WorkflowNodeRunState = (typeof WORKFLOW_NODE_RUN_STATES)[number];

export interface WorkflowNodeRunRecordDto {
  state: WorkflowNodeRunState;
  workItemId?: string;
  iteration?: number;
  error?: string;
  output?: string;
  startedAt?: number;
  endedAt?: number;
}

/** Browser-safe mirror of WorkflowV2.WorkflowDagState. */
export interface WorkflowDagStateDto {
  nodes: Record<string, WorkflowNodeRunRecordDto>;
  rejectIterations?: Record<string, number>;
  rejectFeedback?: Record<string, string>;
}

export interface WorkflowRunDto {
  id: ULID;
  projectId: ULID;
  /** = workflow_runs_v2.workflow_id (the definition slug). */
  workflowSlug: string;
  workflowName: string;
  /** sha256 of the frozen workflow_yaml_snapshot — traces the run to the exact
   *  definition content it executed. */
  definitionHash: string;
  status: WorkflowRunStatus;
  /** Monotonic write counter (workflow_runs_v2.rev). */
  rev: number;
  workItemId: ULID | null;
  worktreePath: string | null;
  lastReason: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  dagState: WorkflowDagStateDto;
}

export interface WorkflowReviewDecision {
  decision: 'approve' | 'reject';
  notes?: string;
}

// ── Request schemas ──────────────────────────────────────────────────────────

export interface FireWorkflowRequest {
  projectId?: ULID;
  /** Run the workflow ON this existing card (it becomes the run root). */
  workItemId?: ULID;
}

export interface WorkflowReviewRequest {
  runId: ULID;
  nodeId: string;
  decision: 'approve' | 'reject';
  notes?: string;
}

export function parseFireWorkflowRequest(input: unknown): ParseResult<FireWorkflowRequest> {
  if (input !== undefined && input !== null && !isRecord(input)) {
    return parseErr('request body must be an object');
  }
  const rec = isRecord(input) ? input : {};
  const request: FireWorkflowRequest = {};
  if (rec.workItemId !== undefined) {
    if (typeof rec.workItemId !== 'string' || !rec.workItemId) {
      return parseErr('workItemId must be a non-empty string');
    }
    request.workItemId = rec.workItemId as ULID;
  }
  if (rec.projectId !== undefined) {
    if (typeof rec.projectId !== 'string' || !rec.projectId) {
      return parseErr('projectId must be a non-empty string');
    }
    request.projectId = rec.projectId;
  }
  return parseOk(request);
}

export function parseWorkflowReviewRequest(input: unknown): ParseResult<WorkflowReviewRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
  const nodeId = typeof input.nodeId === 'string' ? input.nodeId.trim() : '';
  if (!runId) return parseErr('runId required');
  if (!nodeId) return parseErr('nodeId required');
  if (input.decision !== 'approve' && input.decision !== 'reject') {
    return parseErr('decision must be approve or reject');
  }
  const request: WorkflowReviewRequest = { runId, nodeId, decision: input.decision };
  if (input.notes !== undefined) {
    if (typeof input.notes !== 'string') return parseErr('notes must be a string');
    request.notes = input.notes;
  }
  return parseOk(request);
}

// ── Canonical live-event payloads ────────────────────────────────────────────

export type WorkflowRunChangedReason =
  | 'fired'
  | 'advanced'
  | 'review-pending'
  | 'review-resolved'
  | 'cancelled'
  | 'failed'
  | 'completed'
  | 'reconciled';

export interface WorkflowRunChangedLivePayload {
  reason: WorkflowRunChangedReason;
  run?: WorkflowRunDto;
}

export type WorkflowReviewFlavor = 'human' | 'orchestrator';
export type WorkflowReviewState = 'pending' | 'approved' | 'rejected';

export interface WorkflowReviewChangedLivePayload {
  runId: string;
  nodeId: string;
  flavor: WorkflowReviewFlavor;
  state: WorkflowReviewState;
  prompt?: string | null;
  notes?: string;
}

export type WorkflowRunChangedLiveEvent = LiveEvent<WorkflowRunChangedLivePayload> & {
  type: 'workflow.run.changed';
  entity: 'workflow-run';
  scope: 'project';
  projectId: ULID;
};

export type WorkflowRunChangedLiveEventFrame = LiveEventFrame<WorkflowRunChangedLivePayload> & {
  event: WorkflowRunChangedLiveEvent;
};

export type WorkflowReviewChangedLiveEvent = LiveEvent<WorkflowReviewChangedLivePayload> & {
  type: 'workflow.review.changed';
  entity: 'workflow-review';
  scope: 'project';
  projectId: ULID;
};

export type WorkflowReviewChangedLiveEventFrame = LiveEventFrame<WorkflowReviewChangedLivePayload> & {
  event: WorkflowReviewChangedLiveEvent;
};

// ── M3a — the run-diary line as a first-class live fact ─────────────────────

/** One `workflow_run_events` row on the wire. `type` is the domain
 *  WorkflowEventType (workflow_started, node_started, agent_dispatched, …);
 *  kept as string here to stay browser-safe without importing @pc/domain. */
export interface WorkflowRunEventDto {
  id: ULID;
  runId: ULID;
  type: string;
  nodeId: string | null;
  data: Record<string, unknown> | null;
  at: number;
}

export interface WorkflowRunEventLivePayload {
  event: WorkflowRunEventDto;
}

export type WorkflowRunEventLiveEvent = LiveEvent<WorkflowRunEventLivePayload> & {
  type: 'workflow.run.event';
  entity: 'workflow-run-event';
  scope: 'project';
  projectId: ULID;
};

export type WorkflowRunEventLiveEventFrame = LiveEventFrame<WorkflowRunEventLivePayload> & {
  event: WorkflowRunEventLiveEvent;
};

export function isWorkflowRunEventLivePayload(
  value: unknown,
): value is WorkflowRunEventLivePayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ev = (value as { event?: unknown }).event;
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return false;
  const e = ev as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.runId === 'string' &&
    typeof e.type === 'string' &&
    (e.nodeId === null || typeof e.nodeId === 'string') &&
    typeof e.at === 'number'
  );
}

// ── Legacy compatibility projections ─────────────────────────────────────────

/** Legacy `workflow-v2-run-changed` envelope. The server already emits this
 *  with the full repo row under `run`; canonical events are additive. */
export interface WorkflowRunChangedRefetchEnvelope {
  type: 'workflow-v2-run-changed';
  projectId: ULID;
  run: WorkflowRunDto;
}

// ── Guards ───────────────────────────────────────────────────────────────────

export function isWorkflowRunStatus(value: unknown): value is WorkflowRunStatus {
  return typeof value === 'string' && (WORKFLOW_RUN_STATUSES as readonly string[]).includes(value);
}

export function isWorkflowRunChangedReason(value: unknown): value is WorkflowRunChangedReason {
  return (
    value === 'fired' ||
    value === 'advanced' ||
    value === 'review-pending' ||
    value === 'review-resolved' ||
    value === 'cancelled' ||
    value === 'failed' ||
    value === 'completed' ||
    value === 'reconciled'
  );
}

export function isWorkflowDagStateDto(value: unknown): value is WorkflowDagStateDto {
  return isRecord(value) && isRecord(value.nodes);
}

export function isWorkflowRunDto(value: unknown): value is WorkflowRunDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.workflowSlug === 'string' &&
    typeof value.workflowName === 'string' &&
    typeof value.definitionHash === 'string' &&
    isWorkflowRunStatus(value.status) &&
    typeof value.rev === 'number' &&
    (value.workItemId === null || typeof value.workItemId === 'string') &&
    (value.worktreePath === null || typeof value.worktreePath === 'string') &&
    (value.lastReason === null || typeof value.lastReason === 'string') &&
    typeof value.createdAt === 'number' &&
    (value.startedAt === null || typeof value.startedAt === 'number') &&
    (value.endedAt === null || typeof value.endedAt === 'number') &&
    isWorkflowDagStateDto(value.dagState)
  );
}

export function isWorkflowRunChangedLivePayload(
  value: unknown,
): value is WorkflowRunChangedLivePayload {
  if (!isRecord(value) || !isWorkflowRunChangedReason(value.reason)) return false;
  if (value.run !== undefined && !isWorkflowRunDto(value.run)) return false;
  return true;
}

export function isWorkflowReviewChangedLivePayload(
  value: unknown,
): value is WorkflowReviewChangedLivePayload {
  if (!isRecord(value)) return false;
  return (
    typeof value.runId === 'string' &&
    typeof value.nodeId === 'string' &&
    (value.flavor === 'human' || value.flavor === 'orchestrator') &&
    (value.state === 'pending' || value.state === 'approved' || value.state === 'rejected') &&
    (value.prompt === undefined || value.prompt === null || typeof value.prompt === 'string') &&
    (value.notes === undefined || typeof value.notes === 'string')
  );
}

export function isWorkflowRunChangedLiveEvent(value: unknown): value is WorkflowRunChangedLiveEvent {
  if (!isLiveEvent(value)) return false;
  if (value.type !== 'workflow.run.changed') return false;
  if (value.entity !== 'workflow-run') return false;
  if (value.scope !== 'project') return false;
  if (typeof value.projectId !== 'string') return false;
  return isWorkflowRunChangedLivePayload(value.payload);
}

export function isWorkflowRunChangedLiveEventFrame(
  value: unknown,
): value is WorkflowRunChangedLiveEventFrame {
  return isLiveEventFrame(value) && isWorkflowRunChangedLiveEvent(value.event);
}

export function isWorkflowReviewChangedLiveEvent(
  value: unknown,
): value is WorkflowReviewChangedLiveEvent {
  return (
    isLiveEvent(value) &&
    value.type === 'workflow.review.changed' &&
    value.entity === 'workflow-review' &&
    value.scope === 'project' &&
    typeof value.projectId === 'string' &&
    isWorkflowReviewChangedLivePayload(value.payload)
  );
}

export function isWorkflowReviewChangedLiveEventFrame(
  value: unknown,
): value is WorkflowReviewChangedLiveEventFrame {
  return isLiveEventFrame(value) && isWorkflowReviewChangedLiveEvent(value.event);
}

// ── Legacy envelope builders + adapters ──────────────────────────────────────

export function buildWorkflowRunChangedRefetchEnvelope(input: {
  projectId: ULID;
  run: WorkflowRunDto;
}): WorkflowRunChangedRefetchEnvelope {
  return { type: 'workflow-v2-run-changed', projectId: input.projectId, run: input.run };
}

/** Legacy `workflow-v2-run-changed` from a canonical run event. Returns null
 *  when the payload carries no run snapshot. */
export function toWorkflowRunChangedRefetchEnvelope(
  event: WorkflowRunChangedLiveEvent,
): WorkflowRunChangedRefetchEnvelope | null {
  if (!event.payload.run) return null;
  return buildWorkflowRunChangedRefetchEnvelope({
    projectId: event.projectId,
    run: event.payload.run,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
