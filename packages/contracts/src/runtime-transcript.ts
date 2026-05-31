// Runtime-transcript contract family (slice 006). Browser-safe, zero runtime deps.
//
// Browser-safe mirror of the EXISTING on-disk replay wire — the server's
// `ReplayEnvelope` / `SessionReplayCheckpoint` (session-replay.ts) and the
// `{ ok, sessionId, highWaterSeq, events }` body the `GET /sessions/:id/events`
// route returns. The shapes are kept BYTE-IDENTICAL: no `projectId`,
// `conversationKind`, `conversationId`, or `createdAt` are added (the richer
// foundation-spec `TranscriptEventDto<T>` is reserved for the later cross-kind
// transcript table). The per-session `seq`/`highWaterSeq` cursor here is the
// transcript replay cursor — distinct from the slice-002 global outbox cursor.

/** Mirror of the server `ReplaySource.kind`. The broader `TranscriptSourceKind`
 *  union from the foundation spec is reserved for the agent/terminal
 *  convergence; this slice carries only the two existing kinds. */
export const TRANSCRIPT_SOURCE_KINDS = ['claude-jsonl', 'legacy-events-jsonl'] as const;
export type TranscriptSourceKind = (typeof TRANSCRIPT_SOURCE_KINDS)[number];

export interface TranscriptSourceDto {
  kind: TranscriptSourceKind;
  cursor: number | null;
}

export const TRANSCRIPT_EVENT_TYPES = ['jsonl', 'event'] as const;
export type TranscriptEventType = (typeof TRANSCRIPT_EVENT_TYPES)[number];

/** Mirror of the server `ReplayEnvelope`. `event` is opaque (`unknown`); the
 *  optional `clientMessageId` mirrors the id-keyed placeholder reconcile stamp
 *  the canonical `jsonl-user` envelope can carry. */
export interface TranscriptEventDto {
  id: string;
  sessionId: string;
  seq: number;
  type: TranscriptEventType;
  kind: string | null;
  event: unknown;
  source: TranscriptSourceDto;
  clientMessageId?: string;
}

/** Mirror of the `{ ok, sessionId, highWaterSeq, events }` route body. The
 *  optional `resetRequired` is reserved for the expired-cursor path and is
 *  omitted on the byte-identical full/after-seq responses. */
export interface TranscriptReplayResponse {
  ok: true;
  sessionId: string;
  highWaterSeq: number;
  events: TranscriptEventDto[];
  resetRequired?: boolean;
}

// ── Guards ───────────────────────────────────────────────────────────────────

export function isTranscriptSourceKind(value: unknown): value is TranscriptSourceKind {
  return (
    typeof value === 'string' &&
    (TRANSCRIPT_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

export function isTranscriptEventType(value: unknown): value is TranscriptEventType {
  return (
    typeof value === 'string' && (TRANSCRIPT_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isTranscriptSourceDto(value: unknown): value is TranscriptSourceDto {
  if (!isRecord(value)) return false;
  return (
    isTranscriptSourceKind(value.kind) &&
    (value.cursor === null || typeof value.cursor === 'number')
  );
}

export function isTranscriptEventDto(value: unknown): value is TranscriptEventDto {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.sessionId !== 'string') return false;
  if (typeof value.seq !== 'number') return false;
  if (!isTranscriptEventType(value.type)) return false;
  if (value.kind !== null && typeof value.kind !== 'string') return false;
  if (!('event' in value)) return false;
  if (!isTranscriptSourceDto(value.source)) return false;
  if (value.clientMessageId !== undefined && typeof value.clientMessageId !== 'string') {
    return false;
  }
  return true;
}

export function isTranscriptReplayResponse(value: unknown): value is TranscriptReplayResponse {
  if (!isRecord(value)) return false;
  if (value.ok !== true) return false;
  if (typeof value.sessionId !== 'string') return false;
  if (typeof value.highWaterSeq !== 'number') return false;
  if (!Array.isArray(value.events)) return false;
  if (value.resetRequired !== undefined && typeof value.resetRequired !== 'boolean') {
    return false;
  }
  return value.events.every(isTranscriptEventDto);
}

// ── After-seq query helpers ──────────────────────────────────────────────────

export interface TranscriptAfterSeqQuery {
  /** Only rows with `seq > afterSeq` are returned. `0` is the full checkpoint. */
  afterSeq: number;
  /** Optional cap on the returned row count (oldest-first). */
  limit?: number;
}

/** Parse the additive `?afterSeq=&limit=` query on the session-events route.
 *  Returns `null` when no `afterSeq` is present (the unchanged full-checkpoint
 *  path). Throws nothing — invalid values clamp to safe defaults. */
export function parseTranscriptAfterSeqQuery(input: {
  afterSeq?: string | null;
  limit?: string | null;
}): TranscriptAfterSeqQuery | null {
  if (input.afterSeq === undefined || input.afterSeq === null || input.afterSeq === '') {
    return null;
  }
  const afterSeq = Number.parseInt(input.afterSeq, 10);
  const safeAfterSeq = Number.isSafeInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0;
  const query: TranscriptAfterSeqQuery = { afterSeq: safeAfterSeq };
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
    const limit = Number.parseInt(input.limit, 10);
    if (Number.isSafeInteger(limit) && limit > 0) query.limit = limit;
  }
  return query;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
