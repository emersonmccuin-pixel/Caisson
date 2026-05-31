// Compatibility adapters for the conversation family (slice 006).
//
// Pure mappers between the @pc/domain OrchestratorSession / @pc/db
// OrchestratorSendQueueRow / on-disk replay-checkpoint shapes and the shared
// @pc/contracts DTOs. The DTOs mirror the EXISTING wire byte-for-byte; these
// adapters drop server-only fields (`deletedAt`, `projectId`/`sessionId` on the
// public send item) rather than widen the wire. Boundary purity:
// @pc/contracts + @pc/domain (+ @pc/db types).

import type {
  ConversationSessionDto,
  RuntimeSendQueueItemDto,
  TranscriptEventDto,
  TranscriptReplayResponse,
  TranscriptSourceDto,
} from '@pc/contracts';
import type { OrchestratorSendQueueRow } from '@pc/db';
import type { OrchestratorSession } from '@pc/domain';

export class ConversationAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationAdapterError';
  }
}

/** OrchestratorSession -> ConversationSessionDto. Drops `deletedAt` (the session
 *  routes filter soft-deleted rows and never emit it). */
export function toConversationSessionDto(row: OrchestratorSession): ConversationSessionDto {
  if (!row || typeof row.id !== 'string') {
    throw new ConversationAdapterError('invalid orchestrator session row: missing id');
  }
  return {
    id: row.id,
    projectId: row.projectId,
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    model: row.model,
    title: row.title,
    status: row.status,
    endedReason: row.endedReason,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    jsonlPath: row.jsonlPath,
    jsonlLineCursor: row.jsonlLineCursor,
  };
}

/** OrchestratorSendQueueRow -> RuntimeSendQueueItemDto. Mirrors the server
 *  `publicSendQueueItem` exactly (no projectId/sessionId on the public item). */
export function toRuntimeSendQueueItemDto(
  row: OrchestratorSendQueueRow,
): RuntimeSendQueueItemDto {
  if (!row || typeof row.id !== 'string') {
    throw new ConversationAdapterError('invalid send-queue row: missing id');
  }
  return {
    id: row.id,
    clientMessageId: row.clientMessageId,
    text: row.text,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deliveryAttempts: row.deliveryAttempts,
    failureReason: row.failureReason,
  };
}

// ── Transcript replay shapes ─────────────────────────────────────────────────
//
// Structural mirrors of the server `ReplaySource`/`ReplayEnvelope`/
// `SessionReplayCheckpoint` (session-replay.ts). Declared here so the repository
// stays free of any apps/server import while preserving byte-identical output.

export interface ReplaySourceLike {
  kind: 'claude-jsonl' | 'legacy-events-jsonl';
  cursor: number | null;
}

export interface ReplayEnvelopeLike {
  id: string;
  sessionId: string;
  seq: number;
  type: 'jsonl' | 'event';
  kind: string | null;
  event: unknown;
  source: ReplaySourceLike;
  clientMessageId?: string;
}

export interface SessionReplayCheckpointLike {
  sessionId: string;
  highWaterSeq: number;
  events: ReplayEnvelopeLike[];
}

export function toTranscriptSourceDto(source: ReplaySourceLike): TranscriptSourceDto {
  return { kind: source.kind, cursor: source.cursor };
}

export function toTranscriptEventDto(env: ReplayEnvelopeLike): TranscriptEventDto {
  const dto: TranscriptEventDto = {
    id: env.id,
    sessionId: env.sessionId,
    seq: env.seq,
    type: env.type,
    kind: env.kind,
    event: env.event,
    source: toTranscriptSourceDto(env.source),
  };
  if (env.clientMessageId !== undefined) dto.clientMessageId = env.clientMessageId;
  return dto;
}

/** Checkpoint -> the byte-identical `{ ok, sessionId, highWaterSeq, events }`
 *  response body. */
export function toTranscriptReplayResponse(
  checkpoint: SessionReplayCheckpointLike,
): TranscriptReplayResponse {
  return {
    ok: true,
    sessionId: checkpoint.sessionId,
    highWaterSeq: checkpoint.highWaterSeq,
    events: checkpoint.events.map(toTranscriptEventDto),
  };
}
