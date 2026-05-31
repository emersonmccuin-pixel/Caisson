// Runtime send-queue contract family (slice 006). Browser-safe, zero runtime deps.
//
// Mirrors the EXISTING send-queue wire exactly: the 8 `orchestrator_send_queue`
// status strings and the `PublicSendQueueItem` shape the `send-ack` /
// `send-queue-snapshot` envelopes and the cancel/retry routes already emit. The
// `SendRuntimeTurn*` request/response shapes back the new `enqueueRuntimeTurn`
// facade command (for mailbox/system turns) — the persisted queue ROW is
// unchanged; `source`/`sourceRef` are recorded by the facade only.

import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

export const RUNTIME_SEND_STATUSES = [
  'queued_busy',
  'queued_spawning',
  'queued_backlog',
  'delivering',
  'delivered_to_pty',
  'observed_in_jsonl',
  'failed',
  'cancelled',
] as const;
export type RuntimeSendStatus = (typeof RUNTIME_SEND_STATUSES)[number];

/** Mirror of the server `PublicSendQueueItem`. Does NOT carry `projectId` or
 *  `sessionId` (the public item never has). */
export interface RuntimeSendQueueItemDto {
  id: ULID;
  clientMessageId: string;
  text: string;
  status: RuntimeSendStatus;
  createdAt: number;
  updatedAt: number;
  deliveryAttempts: number;
  failureReason: string | null;
}

export const RUNTIME_TURN_SOURCES = ['user', 'mailbox', 'workflow', 'system'] as const;
export type RuntimeTurnSource = (typeof RUNTIME_TURN_SOURCES)[number];

export interface SendRuntimeTurnRequest {
  projectId: ULID;
  sessionId?: ULID;
  clientMessageId: string;
  text: string;
  source: RuntimeTurnSource;
  sourceRef?: string;
}

/** `received` mirrors a direct ready send; `queued` mirrors an enqueue. */
export interface SendRuntimeTurnResponse {
  ok: true;
  status: 'received' | 'queued';
  queueItem: RuntimeSendQueueItemDto;
}

// ── Guards / parsers ─────────────────────────────────────────────────────────

export function isRuntimeSendStatus(value: unknown): value is RuntimeSendStatus {
  return (
    typeof value === 'string' && (RUNTIME_SEND_STATUSES as readonly string[]).includes(value)
  );
}

export function isRuntimeTurnSource(value: unknown): value is RuntimeTurnSource {
  return (
    typeof value === 'string' && (RUNTIME_TURN_SOURCES as readonly string[]).includes(value)
  );
}

export function isRuntimeSendQueueItemDto(value: unknown): value is RuntimeSendQueueItemDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.clientMessageId === 'string' &&
    typeof value.text === 'string' &&
    isRuntimeSendStatus(value.status) &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.deliveryAttempts === 'number' &&
    (value.failureReason === null || typeof value.failureReason === 'string')
  );
}

export function parseSendRuntimeTurnRequest(
  input: unknown,
): ParseResult<SendRuntimeTurnRequest> {
  if (!isRecord(input)) return parseErr('request body must be an object');
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  if (!projectId) return parseErr('projectId required');
  const text = typeof input.text === 'string' ? input.text : '';
  if (!text) return parseErr('text required');
  const clientMessageId =
    typeof input.clientMessageId === 'string' ? input.clientMessageId.trim() : '';
  if (!clientMessageId) return parseErr('clientMessageId required');
  const source = input.source;
  if (!isRuntimeTurnSource(source)) {
    return parseErr('source must be one of user|mailbox|workflow|system');
  }
  const request: SendRuntimeTurnRequest = {
    projectId,
    clientMessageId,
    text,
    source,
  };
  if (input.sessionId !== undefined && input.sessionId !== null) {
    if (typeof input.sessionId !== 'string') return parseErr('sessionId must be a string');
    request.sessionId = input.sessionId;
  }
  if (input.sourceRef !== undefined && input.sourceRef !== null) {
    if (typeof input.sourceRef !== 'string') return parseErr('sourceRef must be a string');
    request.sourceRef = input.sourceRef;
  }
  return parseOk(request);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
