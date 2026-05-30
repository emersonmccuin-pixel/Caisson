// Agent-run contract family (slice 005). Browser-safe, zero runtime deps.
//
// Owns `AgentRunDto` (browser-safe mirror of the broadcast v1 `AgentRunRecord`),
// the invoke/continue request schemas, and the canonical `agent.run.changed`
// live-event payload + guards. Agent-run events are PROJECT-scoped; `version`
// carries `agent_runs.rev` for rev-aware upserts. Mirrors the helper trio
// (build*/is*/to*) in workflow-runs.ts. The legacy `agent-run-changed` WS name
// is preserved as a compatibility projection via `toLegacyAgentRunChanged`.

import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
  type LiveEventFrame,
} from './live-events.ts';
import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

export const AGENT_RUN_STATUSES = [
  'queued',
  'spawning',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Browser-safe mirror of the broadcast v1 `AgentRunRecord`. `wait` is dropped
 *  (a constant `false` shim); the legacy adapter re-adds it. */
export interface AgentRunDto {
  runId: ULID;
  /** = ccSessionId. */
  sessionId: string;
  agentName: string;
  model: string;
  projectId: ULID;
  parentWorkItemId: ULID | null;
  dispatcherSessionId: string;
  worktreeDir: string;
  startedAt: number;
  status: AgentRunStatus;
  result: string;
  failureReason: string | null;
  failureCause: string | null;
  endedAt: number | null;
  /** Monotonic write counter (agent_runs.rev). */
  rev: number;
}

// ── Request schemas ──────────────────────────────────────────────────────────

export interface InvokeAgentRequest {
  input: string;
  parentWorkItemId?: ULID | null;
  workItemId?: ULID | null;
  parentInvokeDepth?: number;
  dispatcherSessionId: string;
}

export interface ContinueAgentRequest {
  input: string;
  dispatcherSessionId: string;
  workItemId?: ULID | null;
}

export function parseInvokeAgentRequest(input: unknown): ParseResult<InvokeAgentRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  const text = typeof input.input === 'string' ? input.input : '';
  if (!text.trim()) return parseErr('input required');
  const dispatcherSessionId =
    typeof input.dispatcherSessionId === 'string' ? input.dispatcherSessionId.trim() : '';
  if (!dispatcherSessionId) {
    return parseErr('dispatcherSessionId required (orchestrator must forward PC_SESSION_ID)');
  }
  const request: InvokeAgentRequest = { input: text, dispatcherSessionId };
  if (input.parentWorkItemId !== undefined && input.parentWorkItemId !== null) {
    if (typeof input.parentWorkItemId !== 'string') {
      return parseErr('parentWorkItemId must be a string');
    }
    request.parentWorkItemId = input.parentWorkItemId;
  }
  if (input.workItemId !== undefined && input.workItemId !== null) {
    if (typeof input.workItemId !== 'string') return parseErr('workItemId must be a string');
    request.workItemId = input.workItemId;
  }
  if (input.parentInvokeDepth !== undefined) {
    if (typeof input.parentInvokeDepth !== 'number') {
      return parseErr('parentInvokeDepth must be a number');
    }
    request.parentInvokeDepth = input.parentInvokeDepth;
  }
  return parseOk(request);
}

export function parseContinueAgentRequest(input: unknown): ParseResult<ContinueAgentRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  const text = typeof input.input === 'string' ? input.input : '';
  if (!text.trim()) return parseErr('input required');
  const dispatcherSessionId =
    typeof input.dispatcherSessionId === 'string' ? input.dispatcherSessionId.trim() : '';
  if (!dispatcherSessionId) {
    return parseErr('dispatcherSessionId required (orchestrator must forward PC_SESSION_ID)');
  }
  const request: ContinueAgentRequest = { input: text, dispatcherSessionId };
  if (input.workItemId !== undefined && input.workItemId !== null) {
    if (typeof input.workItemId !== 'string') return parseErr('workItemId must be a string');
    request.workItemId = input.workItemId;
  }
  return parseOk(request);
}

// ── Canonical live-event payload ─────────────────────────────────────────────

export type AgentRunChangedReason =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'paused'
  | 'resumed'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'reconciled';

export const AGENT_RUN_CHANGED_REASONS: readonly AgentRunChangedReason[] = [
  'queued',
  'spawning',
  'running',
  'paused',
  'resumed',
  'completed',
  'failed',
  'cancelled',
  'reconciled',
];

export interface AgentRunChangedLivePayload {
  reason: AgentRunChangedReason;
  /** Full snapshot with the current rev. */
  run: AgentRunDto;
  /** Set on `reason:'paused'`. */
  pendingAskId?: ULID | null;
}

export type AgentRunChangedLiveEvent = LiveEvent<AgentRunChangedLivePayload> & {
  type: 'agent.run.changed';
  entity: 'agent-run';
  scope: 'project';
  projectId: ULID;
};

export type AgentRunChangedLiveEventFrame = LiveEventFrame<AgentRunChangedLivePayload> & {
  event: AgentRunChangedLiveEvent;
};

// ── Legacy compatibility projection ──────────────────────────────────────────

/** Legacy v1 `AgentRunRecord` shape carried by the `agent-run-changed` WS
 *  envelope. Lossless superset of `AgentRunDto` (re-adds the constant `wait`). */
export interface LegacyAgentRunRecord {
  runId: ULID;
  sessionId: string;
  agentName: string;
  model: string;
  projectId: ULID;
  parentWorkItemId: ULID | null;
  dispatcherSessionId: string;
  wait: false;
  worktreeDir: string;
  startedAt: number;
  status: AgentRunStatus;
  result: string;
  failureReason: string | null;
  failureCause: string | null;
  endedAt: number | null;
  rev: number;
}

export interface AgentRunChangedRefetchEnvelope {
  type: 'agent-run-changed';
  record: LegacyAgentRunRecord;
}

// ── Guards ───────────────────────────────────────────────────────────────────

export function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return typeof value === 'string' && (AGENT_RUN_STATUSES as readonly string[]).includes(value);
}

export function isAgentRunChangedReason(value: unknown): value is AgentRunChangedReason {
  return (
    typeof value === 'string' &&
    (AGENT_RUN_CHANGED_REASONS as readonly string[]).includes(value)
  );
}

export function isAgentRunDto(value: unknown): value is AgentRunDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.runId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.agentName === 'string' &&
    typeof value.model === 'string' &&
    typeof value.projectId === 'string' &&
    (value.parentWorkItemId === null || typeof value.parentWorkItemId === 'string') &&
    typeof value.dispatcherSessionId === 'string' &&
    typeof value.worktreeDir === 'string' &&
    typeof value.startedAt === 'number' &&
    isAgentRunStatus(value.status) &&
    typeof value.result === 'string' &&
    (value.failureReason === null || typeof value.failureReason === 'string') &&
    (value.failureCause === null || typeof value.failureCause === 'string') &&
    (value.endedAt === null || typeof value.endedAt === 'number') &&
    typeof value.rev === 'number'
  );
}

export function isAgentRunChangedLivePayload(
  value: unknown,
): value is AgentRunChangedLivePayload {
  if (!isRecord(value) || !isAgentRunChangedReason(value.reason)) return false;
  if (!isAgentRunDto(value.run)) return false;
  if (
    value.pendingAskId !== undefined &&
    value.pendingAskId !== null &&
    typeof value.pendingAskId !== 'string'
  ) {
    return false;
  }
  return true;
}

export function isAgentRunChangedLiveEvent(value: unknown): value is AgentRunChangedLiveEvent {
  if (!isLiveEvent(value)) return false;
  if (value.type !== 'agent.run.changed') return false;
  if (value.entity !== 'agent-run') return false;
  if (value.scope !== 'project') return false;
  if (typeof value.projectId !== 'string') return false;
  return isAgentRunChangedLivePayload(value.payload);
}

export function isAgentRunChangedLiveEventFrame(
  value: unknown,
): value is AgentRunChangedLiveEventFrame {
  return isLiveEventFrame(value) && isAgentRunChangedLiveEvent(value.event);
}

// ── Legacy envelope builder + adapter ────────────────────────────────────────

/** Lossless v1 record from a DTO. Re-adds the constant `wait:false`. */
export function toLegacyAgentRunRecord(run: AgentRunDto): LegacyAgentRunRecord {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    agentName: run.agentName,
    model: run.model,
    projectId: run.projectId,
    parentWorkItemId: run.parentWorkItemId,
    dispatcherSessionId: run.dispatcherSessionId,
    wait: false,
    worktreeDir: run.worktreeDir,
    startedAt: run.startedAt,
    status: run.status,
    result: run.result,
    failureReason: run.failureReason,
    failureCause: run.failureCause,
    endedAt: run.endedAt,
    rev: run.rev,
  };
}

export function buildAgentRunChangedRefetchEnvelope(
  run: AgentRunDto,
): AgentRunChangedRefetchEnvelope {
  return { type: 'agent-run-changed', record: toLegacyAgentRunRecord(run) };
}

/** Legacy `agent-run-changed` envelope from a canonical agent-run event. */
export function toLegacyAgentRunChanged(
  event: AgentRunChangedLiveEvent,
): AgentRunChangedRefetchEnvelope {
  return buildAgentRunChangedRefetchEnvelope(event.payload.run);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
