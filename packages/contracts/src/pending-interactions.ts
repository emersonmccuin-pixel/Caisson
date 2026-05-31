// Pending-interaction contract family (slice 007). Browser-safe, zero deps.
//
// A general cross-system ask/review/approval state separate from mailbox
// delivery (spec §5). The first writer this slice is the `/api/ask` ask-shadow
// (kind `runtime-hook-ask`); agent `pending_asks` is NOT mirrored here (slice
// decision). The canonical `pending-interaction.changed` live event is
// project-scoped (`PendingInteractionDto.projectId` is non-null); `version`
// carries the interaction `version` for stale-update guards.
//
// Boundary purity: no apps/@pc/db/@pc/domain value imports, Hono, React, Node.

import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
  type LiveEventFrame,
} from './live-events.ts';
import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

export const PENDING_INTERACTION_KINDS = [
  'agent-asks-orchestrator',
  'agent-asks-user',
  'agent-approval-request',
  'workflow-orchestrator-review',
  'workflow-human-review',
  'runtime-hook-ask',
] as const;
export type PendingInteractionKind = (typeof PENDING_INTERACTION_KINDS)[number];

export const PENDING_INTERACTION_STATUSES = [
  'open',
  'answered',
  'cancelled',
  'expired',
  'failed',
] as const;
export type PendingInteractionStatus = (typeof PENDING_INTERACTION_STATUSES)[number];

export const PENDING_INTERACTION_SOURCE_KINDS = [
  'agent-run',
  'workflow-run-node',
  'runtime-hook',
] as const;
export type PendingInteractionSourceKind = (typeof PENDING_INTERACTION_SOURCE_KINDS)[number];

export interface PendingInteractionSource {
  kind: PendingInteractionSourceKind;
  id: string;
}

export interface PendingInteractionOption {
  value: string;
  label: string;
}

export interface PendingInteractionDto {
  id: ULID;
  projectId: ULID;
  kind: PendingInteractionKind;
  status: PendingInteractionStatus;
  source: PendingInteractionSource;
  prompt: string;
  context: string | null;
  options: PendingInteractionOption[] | null;
  answer: string | null;
  answeredBy: 'orchestrator' | 'user' | null;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
  version: number;
}

// ── Command shapes ────────────────────────────────────────────────────────────

export interface AnswerPendingInteractionRequest {
  answer: string;
  answeredBy: 'orchestrator' | 'user';
}

export function parseAnswerPendingInteractionRequest(
  input: unknown,
): ParseResult<AnswerPendingInteractionRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  const answer = typeof input.answer === 'string' ? input.answer : '';
  if (!answer) return parseErr('answer required');
  if (input.answeredBy !== 'orchestrator' && input.answeredBy !== 'user') {
    return parseErr('answeredBy must be orchestrator | user');
  }
  return parseOk({ answer, answeredBy: input.answeredBy });
}

// ── Guards ────────────────────────────────────────────────────────────────────

export function isPendingInteractionKind(value: unknown): value is PendingInteractionKind {
  return (
    typeof value === 'string' && (PENDING_INTERACTION_KINDS as readonly string[]).includes(value)
  );
}

export function isPendingInteractionStatus(value: unknown): value is PendingInteractionStatus {
  return (
    typeof value === 'string' &&
    (PENDING_INTERACTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isPendingInteractionSource(value: unknown): value is PendingInteractionSource {
  return (
    isRecord(value) &&
    (PENDING_INTERACTION_SOURCE_KINDS as readonly string[]).includes(value.kind as string) &&
    typeof value.id === 'string'
  );
}

export function isPendingInteractionOption(value: unknown): value is PendingInteractionOption {
  return isRecord(value) && typeof value.value === 'string' && typeof value.label === 'string';
}

export function isPendingInteractionDto(value: unknown): value is PendingInteractionDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    isPendingInteractionKind(value.kind) &&
    isPendingInteractionStatus(value.status) &&
    isPendingInteractionSource(value.source) &&
    typeof value.prompt === 'string' &&
    (value.context === null || typeof value.context === 'string') &&
    (value.options === null ||
      (Array.isArray(value.options) && value.options.every(isPendingInteractionOption))) &&
    (value.answer === null || typeof value.answer === 'string') &&
    (value.answeredBy === null ||
      value.answeredBy === 'orchestrator' ||
      value.answeredBy === 'user') &&
    typeof value.createdAt === 'number' &&
    (value.answeredAt === null || typeof value.answeredAt === 'number') &&
    (value.cancelledAt === null || typeof value.cancelledAt === 'number') &&
    typeof value.version === 'number'
  );
}

// ── Canonical live-event payload (project-scoped) ─────────────────────────────

export interface PendingInteractionChangedLivePayload {
  interactionId: ULID;
  kind: PendingInteractionKind;
  status: PendingInteractionStatus;
  version: number;
}

export type PendingInteractionChangedLiveEvent =
  LiveEvent<PendingInteractionChangedLivePayload> & {
    type: 'pending-interaction.changed';
    entity: 'pending-interaction';
    scope: 'project';
    projectId: ULID;
  };

export type PendingInteractionChangedLiveEventFrame =
  LiveEventFrame<PendingInteractionChangedLivePayload> & {
    event: PendingInteractionChangedLiveEvent;
  };

export function isPendingInteractionChangedLivePayload(
  value: unknown,
): value is PendingInteractionChangedLivePayload {
  if (!isRecord(value)) return false;
  return (
    typeof value.interactionId === 'string' &&
    isPendingInteractionKind(value.kind) &&
    isPendingInteractionStatus(value.status) &&
    typeof value.version === 'number'
  );
}

export function isPendingInteractionChangedLiveEvent(
  value: unknown,
): value is PendingInteractionChangedLiveEvent {
  if (!isLiveEvent(value)) return false;
  if (value.type !== 'pending-interaction.changed') return false;
  if (value.entity !== 'pending-interaction') return false;
  if (value.scope !== 'project') return false;
  if (typeof value.projectId !== 'string') return false;
  return isPendingInteractionChangedLivePayload(value.payload);
}

export function isPendingInteractionChangedLiveEventFrame(
  value: unknown,
): value is PendingInteractionChangedLiveEventFrame {
  return isLiveEventFrame(value) && isPendingInteractionChangedLiveEvent(value.event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
