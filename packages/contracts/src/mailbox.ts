// Mailbox contract family (slice 007). Browser-safe, zero runtime deps.
//
// Owns the typed `MailboxAddress` recipient union, the message/recipient/
// delivery DTOs, the enqueue/read/action/dismiss/list command shapes, and the
// canonical `mailbox.message.changed` / `mailbox.delivery.changed` live-event
// payloads + guards. Mailbox lives ALONGSIDE Channel (slice 007 is the
// platform; no sender is cut over — that is slice 008).
//
// Boundary purity (slices 001–006): no imports from apps, @pc/db, @pc/domain
// value imports (type-only `ULID` is fine), Hono, React, or Node built-ins.
// Parsers accept `unknown` and return `ParseResult<T>`.

import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
  type LiveEventFrame,
} from './live-events.ts';
import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

// ── Recipient address union (spec §5) ────────────────────────────────────────

export type MailboxAddress =
  | { kind: 'user-inbox'; userId: 'local-user'; projectId: string | null }
  | { kind: 'project-inbox'; projectId: string }
  | { kind: 'active-orchestrator'; projectId: string }
  | { kind: 'orchestrator-session'; projectId: string; sessionId: string }
  | { kind: 'agent-run'; projectId: string; agentRunId: string }
  | { kind: 'workflow-review'; projectId: string; workflowRunId: string; nodeId: string };

export const MAILBOX_ADDRESS_KINDS = [
  'user-inbox',
  'project-inbox',
  'active-orchestrator',
  'orchestrator-session',
  'agent-run',
  'workflow-review',
] as const;
export type MailboxAddressKind = (typeof MAILBOX_ADDRESS_KINDS)[number];

// ── Enums (spec §5) ───────────────────────────────────────────────────────────

export const MAILBOX_MESSAGE_KINDS = [
  'agent-question',
  'agent-approval',
  'agent-terminal',
  /** P9/FD-17 stall ladder rung 2 — a running agent has been silent past the
   *  notify window. Delivered to the project orchestrator (active-orchestrator,
   *  orchestrator-turn) with the verify-alive read; the orchestrator decides
   *  wait / inspect / kill. Never accompanies a kill — silence doesn't execute. */
  'agent-stalled',
  'workflow-review',
  /** M8 (FD-7) — a contract parked at the human-review verification tier.
   *  Delivered to the human user-inbox; approve/reject ride the existing
   *  work-item verification doors. */
  'verification-review',
  /** Workflow-engine redesign — a run failed. Delivered to BOTH the human
   *  user-inbox AND the project orchestrator (active-orchestrator); when no
   *  orchestrator is live the delivery persists and drains on its next pass. */
  'workflow-run-failed',
  'external-webhook',
  'runtime-hook-ask',
  'system-notice',
  /** M4b/FD-8 — the stale-ask watchdog: an agent's pc_ask_* question has sat
   *  unanswered past the threshold. ONE user-inbox card per ask (idempotency
   *  `ask-stale:<askId>`), actionable — answer/cancel ride the EXISTING
   *  pending-ask doors; a decision through ANY door clears the card
   *  (resolve-by-source on sourceKind 'agent' + askId). */
  'agent-ask-escalated',
] as const;
export type MailboxMessageKind = (typeof MAILBOX_MESSAGE_KINDS)[number];

/** M8 (FD-7) — kinds that ask the human for a DECISION (approve/reject/answer),
 *  not just attention. Drives the inbox `actionable` count + the actionableOnly
 *  filter. */
export const ACTIONABLE_MAILBOX_KINDS = [
  'workflow-review',
  'verification-review',
  'agent-ask-escalated',
  // ☠ 'workflow-run-failed' removed (user decision 2026-06-05): a failed run is
  // no longer a human-inbox card. It notifies the orchestrator and lives in
  // Workflows → Runs (filter: Failed), where the "Resume from failed step"
  // action already exists. The kind stays in MAILBOX_MESSAGE_KINDS for the
  // orchestrator-turn delivery; it is simply never human-actionable.
] as const;
export function isActionableMailboxKind(kind: string): boolean {
  return (ACTIONABLE_MAILBOX_KINDS as readonly string[]).includes(kind);
}

export const MAILBOX_DELIVERY_CHANNELS = [
  'ui-inbox',
  'orchestrator-turn',
  'compat-channel',
] as const;
export type MailboxDeliveryChannel = (typeof MAILBOX_DELIVERY_CHANNELS)[number];

export const MAILBOX_DELIVERY_STATUSES = [
  'pending',
  'leased',
  'accepted',
  'retrying',
  'failed',
  'dead-lettered',
  'cancelled',
] as const;
export type MailboxDeliveryStatus = (typeof MAILBOX_DELIVERY_STATUSES)[number];

export const MAILBOX_TARGET_REF_KINDS = ['send-queue', 'ui-inbox', 'channel'] as const;
export type MailboxTargetRefKind = (typeof MAILBOX_TARGET_REF_KINDS)[number];

export interface MailboxTargetRef {
  kind: MailboxTargetRefKind | null;
  id: string | null;
}

// ── DTOs (spec §5) ────────────────────────────────────────────────────────────

export interface MailboxMessageSource {
  kind: string;
  id: string | null;
}

export interface MailboxMessageDto {
  id: ULID;
  projectId: ULID | null;
  kind: MailboxMessageKind;
  subject: string | null;
  body: string;
  payload: Record<string, unknown>;
  source: MailboxMessageSource;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxRecipientDto {
  id: ULID;
  messageId: ULID;
  address: MailboxAddress;
  readAt: number | null;
  actionedAt: number | null;
  dismissedAt: number | null;
}

export interface MailboxDeliveryDto {
  id: ULID;
  messageId: ULID;
  recipientId: ULID;
  channel: MailboxDeliveryChannel;
  status: MailboxDeliveryStatus;
  attempts: number;
  nextAttemptAt: number | null;
  targetRef: MailboxTargetRef;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Command shapes ────────────────────────────────────────────────────────────

export interface EnqueueMailboxRecipientInput {
  address: MailboxAddress;
  channel: MailboxDeliveryChannel;
}

export interface EnqueueMailboxMessageRequest {
  kind: MailboxMessageKind;
  body: string;
  subject?: string | null;
  payload?: Record<string, unknown>;
  source?: MailboxMessageSource;
  idempotencyKey: string;
  recipients: EnqueueMailboxRecipientInput[];
}

export interface MarkRecipientReadRequest {
  _empty?: never;
}
export interface ActionRecipientRequest {
  _empty?: never;
}
export interface DismissRecipientRequest {
  _empty?: never;
}

export interface ListMailboxQuery {
  /** When true, only return recipients with no read/dismiss timestamp. */
  unreadOnly?: boolean;
  /** When true, only return recipients that have an actionable interaction. */
  actionableOnly?: boolean;
}

// ── Guards ────────────────────────────────────────────────────────────────────

export function isMailboxMessageKind(value: unknown): value is MailboxMessageKind {
  return typeof value === 'string' && (MAILBOX_MESSAGE_KINDS as readonly string[]).includes(value);
}

export function isMailboxDeliveryChannel(value: unknown): value is MailboxDeliveryChannel {
  return (
    typeof value === 'string' && (MAILBOX_DELIVERY_CHANNELS as readonly string[]).includes(value)
  );
}

export function isMailboxDeliveryStatus(value: unknown): value is MailboxDeliveryStatus {
  return (
    typeof value === 'string' && (MAILBOX_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

export function isMailboxAddress(value: unknown): value is MailboxAddress {
  return parseMailboxAddress(value).ok;
}

/** Parse a recipient address, rejecting missing required project/session/run/
 *  node ids. NOTE `user-inbox.projectId` MAY be null (the global inbox). */
export function parseMailboxAddress(input: unknown): ParseResult<MailboxAddress> {
  if (!isRecord(input)) return parseErr('address must be an object');
  const kind = input.kind;
  switch (kind) {
    case 'user-inbox': {
      if (input.userId !== 'local-user') return parseErr('user-inbox.userId must be local-user');
      if (input.projectId !== null && !isNonEmptyString(input.projectId)) {
        return parseErr('user-inbox.projectId must be a string or null');
      }
      return parseOk({ kind, userId: 'local-user', projectId: input.projectId as string | null });
    }
    case 'project-inbox':
    case 'active-orchestrator': {
      if (!isNonEmptyString(input.projectId)) return parseErr(`${kind}.projectId required`);
      return parseOk({ kind, projectId: input.projectId });
    }
    case 'orchestrator-session': {
      if (!isNonEmptyString(input.projectId)) return parseErr('orchestrator-session.projectId required');
      if (!isNonEmptyString(input.sessionId)) return parseErr('orchestrator-session.sessionId required');
      return parseOk({ kind, projectId: input.projectId, sessionId: input.sessionId });
    }
    case 'agent-run': {
      if (!isNonEmptyString(input.projectId)) return parseErr('agent-run.projectId required');
      if (!isNonEmptyString(input.agentRunId)) return parseErr('agent-run.agentRunId required');
      return parseOk({ kind, projectId: input.projectId, agentRunId: input.agentRunId });
    }
    case 'workflow-review': {
      if (!isNonEmptyString(input.projectId)) return parseErr('workflow-review.projectId required');
      if (!isNonEmptyString(input.workflowRunId)) return parseErr('workflow-review.workflowRunId required');
      if (!isNonEmptyString(input.nodeId)) return parseErr('workflow-review.nodeId required');
      return parseOk({
        kind,
        projectId: input.projectId,
        workflowRunId: input.workflowRunId,
        nodeId: input.nodeId,
      });
    }
    default:
      return parseErr('unknown address kind');
  }
}

/** The project context a recipient address binds to (null for the global
 *  user-inbox). Drives the live-event scope (`global ⟺ projectId IS NULL`). */
export function mailboxAddressProjectId(address: MailboxAddress): string | null {
  if (address.kind === 'user-inbox') return address.projectId;
  return address.projectId;
}

export function isMailboxTargetRef(value: unknown): value is MailboxTargetRef {
  if (!isRecord(value)) return false;
  const kindOk =
    value.kind === null || (MAILBOX_TARGET_REF_KINDS as readonly string[]).includes(value.kind as string);
  const idOk = value.id === null || typeof value.id === 'string';
  return kindOk && idOk;
}

export function isMailboxMessageDto(value: unknown): value is MailboxMessageDto {
  if (!isRecord(value)) return false;
  if (!isRecord(value.source)) return false;
  return (
    typeof value.id === 'string' &&
    (value.projectId === null || typeof value.projectId === 'string') &&
    isMailboxMessageKind(value.kind) &&
    (value.subject === null || typeof value.subject === 'string') &&
    typeof value.body === 'string' &&
    isRecord(value.payload) &&
    typeof value.source.kind === 'string' &&
    (value.source.id === null || typeof value.source.id === 'string') &&
    typeof value.idempotencyKey === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

export function isMailboxRecipientDto(value: unknown): value is MailboxRecipientDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.messageId === 'string' &&
    isMailboxAddress(value.address) &&
    (value.readAt === null || typeof value.readAt === 'number') &&
    (value.actionedAt === null || typeof value.actionedAt === 'number') &&
    (value.dismissedAt === null || typeof value.dismissedAt === 'number')
  );
}

export function isMailboxDeliveryDto(value: unknown): value is MailboxDeliveryDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.recipientId === 'string' &&
    isMailboxDeliveryChannel(value.channel) &&
    isMailboxDeliveryStatus(value.status) &&
    typeof value.attempts === 'number' &&
    (value.nextAttemptAt === null || typeof value.nextAttemptAt === 'number') &&
    isMailboxTargetRef(value.targetRef) &&
    (value.lastError === null || typeof value.lastError === 'string') &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

// ── Parsers ────────────────────────────────────────────────────────────────────

export function parseEnqueueMailboxMessageRequest(
  input: unknown,
): ParseResult<EnqueueMailboxMessageRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  if (!isMailboxMessageKind(input.kind)) return parseErr('kind invalid');
  if (typeof input.body !== 'string') return parseErr('body must be a string');
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (!idempotencyKey) return parseErr('idempotencyKey required');
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    return parseErr('recipients must be a non-empty array');
  }

  const recipients: EnqueueMailboxRecipientInput[] = [];
  for (const r of input.recipients) {
    if (!isRecord(r)) return parseErr('each recipient must be an object');
    const addr = parseMailboxAddress(r.address);
    if (!addr.ok) return parseErr(`recipient.address: ${addr.error}`);
    if (!isMailboxDeliveryChannel(r.channel)) return parseErr('recipient.channel invalid');
    recipients.push({ address: addr.value, channel: r.channel });
  }

  const request: EnqueueMailboxMessageRequest = {
    kind: input.kind,
    body: input.body,
    idempotencyKey,
    recipients,
  };

  if (input.subject !== undefined && input.subject !== null) {
    if (typeof input.subject !== 'string') return parseErr('subject must be a string');
    request.subject = input.subject;
  }
  if (input.payload !== undefined && input.payload !== null) {
    if (!isRecord(input.payload)) return parseErr('payload must be an object');
    request.payload = input.payload;
  }
  if (input.source !== undefined && input.source !== null) {
    if (!isRecord(input.source) || typeof input.source.kind !== 'string') {
      return parseErr('source must be { kind, id }');
    }
    if (input.source.id !== null && typeof input.source.id !== 'string') {
      return parseErr('source.id must be a string or null');
    }
    request.source = { kind: input.source.kind, id: (input.source.id as string | null) ?? null };
  }

  return parseOk(request);
}

export function parseMarkRecipientReadRequest(
  input: unknown,
): ParseResult<MarkRecipientReadRequest> {
  if (input !== undefined && input !== null && !isRecord(input)) {
    return parseErr('request body must be an object');
  }
  return parseOk({});
}
export const parseActionRecipientRequest = parseMarkRecipientReadRequest as (
  input: unknown,
) => ParseResult<ActionRecipientRequest>;
export const parseDismissRecipientRequest = parseMarkRecipientReadRequest as (
  input: unknown,
) => ParseResult<DismissRecipientRequest>;

export function parseListMailboxQuery(input: unknown): ParseResult<ListMailboxQuery> {
  const query = isRecord(input) ? input : {};
  const parsed: ListMailboxQuery = {};
  if (query.unreadOnly === '1' || query.unreadOnly === true) parsed.unreadOnly = true;
  if (query.actionableOnly === '1' || query.actionableOnly === true) parsed.actionableOnly = true;
  return parseOk(parsed);
}

// ── Canonical live-event payloads (spec §9; scope-from-project) ────────────────

export interface MailboxRecipientSummary {
  total: number;
  unread: number;
  actionable: number;
}

export interface MailboxMessageChangedLivePayload {
  messageId: ULID;
  kind: MailboxMessageKind;
  recipientSummary: MailboxRecipientSummary;
}

export interface MailboxDeliveryChangedLivePayload {
  deliveryId: ULID;
  messageId: ULID;
  status: MailboxDeliveryStatus;
  attempts: number;
  targetRef: MailboxTargetRef;
  lastError?: string | null;
}

export type MailboxMessageChangedLiveEvent = LiveEvent<MailboxMessageChangedLivePayload> & {
  type: 'mailbox.message.changed';
  entity: 'mailbox-message';
};
export type MailboxMessageChangedLiveEventFrame =
  LiveEventFrame<MailboxMessageChangedLivePayload> & {
    event: MailboxMessageChangedLiveEvent;
  };

export type MailboxDeliveryChangedLiveEvent = LiveEvent<MailboxDeliveryChangedLivePayload> & {
  type: 'mailbox.delivery.changed';
  entity: 'mailbox-message';
};
export type MailboxDeliveryChangedLiveEventFrame =
  LiveEventFrame<MailboxDeliveryChangedLivePayload> & {
    event: MailboxDeliveryChangedLiveEvent;
  };

export function isMailboxRecipientSummary(value: unknown): value is MailboxRecipientSummary {
  return (
    isRecord(value) &&
    typeof value.total === 'number' &&
    typeof value.unread === 'number' &&
    typeof value.actionable === 'number'
  );
}

export function isMailboxMessageChangedLivePayload(
  value: unknown,
): value is MailboxMessageChangedLivePayload {
  if (!isRecord(value)) return false;
  if (typeof value.messageId !== 'string') return false;
  if (!isMailboxMessageKind(value.kind)) return false;
  if (!isMailboxRecipientSummary(value.recipientSummary)) return false;
  return true;
}

export function isMailboxDeliveryChangedLivePayload(
  value: unknown,
): value is MailboxDeliveryChangedLivePayload {
  if (!isRecord(value)) return false;
  if (typeof value.deliveryId !== 'string') return false;
  if (typeof value.messageId !== 'string') return false;
  if (!isMailboxDeliveryStatus(value.status)) return false;
  if (typeof value.attempts !== 'number') return false;
  if (!isMailboxTargetRef(value.targetRef)) return false;
  if (value.lastError !== undefined && value.lastError !== null && typeof value.lastError !== 'string') {
    return false;
  }
  return true;
}

export function isMailboxMessageChangedLiveEvent(
  value: unknown,
): value is MailboxMessageChangedLiveEvent {
  if (!isLiveEvent(value)) return false;
  if (value.type !== 'mailbox.message.changed') return false;
  if (value.entity !== 'mailbox-message') return false;
  return isMailboxMessageChangedLivePayload(value.payload);
}

export function isMailboxMessageChangedLiveEventFrame(
  value: unknown,
): value is MailboxMessageChangedLiveEventFrame {
  return isLiveEventFrame(value) && isMailboxMessageChangedLiveEvent(value.event);
}

export function isMailboxDeliveryChangedLiveEvent(
  value: unknown,
): value is MailboxDeliveryChangedLiveEvent {
  if (!isLiveEvent(value)) return false;
  if (value.type !== 'mailbox.delivery.changed') return false;
  if (value.entity !== 'mailbox-message') return false;
  return isMailboxDeliveryChangedLivePayload(value.payload);
}

export function isMailboxDeliveryChangedLiveEventFrame(
  value: unknown,
): value is MailboxDeliveryChangedLiveEventFrame {
  return isLiveEventFrame(value) && isMailboxDeliveryChangedLiveEvent(value.event);
}

// ── helpers ────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
