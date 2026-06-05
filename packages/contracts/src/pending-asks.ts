// Pending-ask contract family (slice 005). Browser-safe, zero runtime deps.
//
// Owns the shared `PendingAskDto` + request schemas for the create / answer /
// cancel pending-ask surfaces. Pending asks do NOT get their own canonical
// live-event family this slice — a pause is surfaced via
// `agent.run.changed (reason:'paused')` (see agent-runs.ts). This module ships
// the DTO + request parsers for the HTTP/MCP request surfaces.

import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

// ☠ M7 (FD-6) / cleanup sweep 2026-06-04 — `'user'` deleted here too (the
// domain enum narrowed in M7; this wire copy lagged). ONE ask door: agents ask
// the orchestrator. Zero `kind='user'` rows exist (verified against the dev DB).
export const PENDING_ASK_KINDS = ['orchestrator', 'approval'] as const;
export type PendingAskKind = (typeof PENDING_ASK_KINDS)[number];

export const PENDING_ASK_STATUSES = ['open', 'answered', 'cancelled'] as const;
export type PendingAskStatus = (typeof PENDING_ASK_STATUSES)[number];

export interface PendingAskOptionDto {
  label: string;
  value: string;
}

/** Browser-safe mirror of the @pc/domain PendingAskRow. */
export interface PendingAskDto {
  id: ULID;
  agentRunId: ULID;
  /** = ccSessionId (CC provider session id). */
  ccSessionId: string;
  projectId: ULID;
  parentWorkItemId: ULID | null;
  kind: PendingAskKind;
  promptBody: string;
  context: string | null;
  options: PendingAskOptionDto[] | null;
  status: PendingAskStatus;
  answeredBy: 'orchestrator' | 'user' | null;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
}

// ── Request schemas ──────────────────────────────────────────────────────────

export interface CreatePendingAskRequest {
  agentRunId: ULID;
  kind: PendingAskKind;
  promptBody: string;
  context?: string | null;
  options?: PendingAskOptionDto[] | null;
}

export interface AnswerPendingAskRequest {
  answer: string;
  answeredBy: 'orchestrator' | 'user';
}

/** Cancel carries no body. Parse-only no-op that tolerates `{}`/undefined. */
export interface CancelPendingAskRequest {
  _empty?: never;
}

export function isPendingAskKind(value: unknown): value is PendingAskKind {
  return typeof value === 'string' && (PENDING_ASK_KINDS as readonly string[]).includes(value);
}

export function isPendingAskStatus(value: unknown): value is PendingAskStatus {
  return typeof value === 'string' && (PENDING_ASK_STATUSES as readonly string[]).includes(value);
}

export function isPendingAskOptionDto(value: unknown): value is PendingAskOptionDto {
  return isRecord(value) && typeof value.label === 'string' && typeof value.value === 'string';
}

export function isPendingAskDto(value: unknown): value is PendingAskDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.agentRunId === 'string' &&
    typeof value.ccSessionId === 'string' &&
    typeof value.projectId === 'string' &&
    (value.parentWorkItemId === null || typeof value.parentWorkItemId === 'string') &&
    isPendingAskKind(value.kind) &&
    typeof value.promptBody === 'string' &&
    (value.context === null || typeof value.context === 'string') &&
    (value.options === null ||
      (Array.isArray(value.options) && value.options.every(isPendingAskOptionDto))) &&
    isPendingAskStatus(value.status) &&
    (value.answeredBy === null ||
      value.answeredBy === 'orchestrator' ||
      value.answeredBy === 'user') &&
    typeof value.createdAt === 'number' &&
    (value.answeredAt === null || typeof value.answeredAt === 'number') &&
    (value.cancelledAt === null || typeof value.cancelledAt === 'number')
  );
}

export function parseCreatePendingAskRequest(
  input: unknown,
): ParseResult<CreatePendingAskRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  const agentRunId = typeof input.agentRunId === 'string' ? input.agentRunId.trim() : '';
  if (!agentRunId) return parseErr('agentRunId required');
  if (!isPendingAskKind(input.kind)) {
    return parseErr('kind must be orchestrator | user | approval');
  }
  const promptBody = typeof input.promptBody === 'string' ? input.promptBody : '';
  if (!promptBody.trim()) return parseErr('promptBody required');

  let options: PendingAskOptionDto[] | null = null;
  if (input.options !== undefined && input.options !== null) {
    if (!Array.isArray(input.options) || !input.options.every(isPendingAskOptionDto)) {
      return parseErr('options must be an array of { label, value }');
    }
    options = input.options as PendingAskOptionDto[];
  }
  if (input.kind === 'approval' && (!options || options.length === 0)) {
    return parseErr('options required (non-empty array) for kind=approval');
  }

  let context: string | null = null;
  if (input.context !== undefined && input.context !== null) {
    if (typeof input.context !== 'string') return parseErr('context must be a string');
    context = input.context;
  }

  const request: CreatePendingAskRequest = { agentRunId, kind: input.kind, promptBody };
  if (context !== null) request.context = context;
  if (options !== null) request.options = options;
  return parseOk(request);
}

export function parseAnswerPendingAskRequest(
  input: unknown,
): ParseResult<AnswerPendingAskRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  const answer = typeof input.answer === 'string' ? input.answer : '';
  if (!answer) return parseErr('answer required');
  if (input.answeredBy !== 'orchestrator' && input.answeredBy !== 'user') {
    return parseErr('answeredBy must be orchestrator | user');
  }
  return parseOk({ answer, answeredBy: input.answeredBy });
}

export function parseCancelPendingAskRequest(
  input: unknown,
): ParseResult<CancelPendingAskRequest> {
  if (input !== undefined && input !== null && !isRecord(input)) {
    return parseErr('request body must be an object');
  }
  return parseOk({});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
