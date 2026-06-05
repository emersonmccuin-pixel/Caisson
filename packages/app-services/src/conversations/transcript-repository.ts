// DbTranscriptRepository (M3b — was FileTranscriptRepository, slice 006).
//
// The conversation replay store is the `conversation_events` table; replay is
// a query. ☠ M3b: the file repository + the `session-replay.ts` parser — the
// on-disk jsonl-events.jsonl files were imported once at boot (renamed
// `*.imported`); the parser survives ONLY inside the backfill importer
// (apps/server conversation-backfill.ts). No file fallback exists.
//
// `listAfter` keeps the reconnect contract: rows with `seq > afterSeq`,
// oldest-first, optional cap — while `highWaterSeq` stays the FULL session
// high water (stable across reconnect). This is the transcript `seq` cursor —
// NOT the slice-002 global outbox cursor.

import {
  getConversationHighWaterSeq as defaultGetHighWaterSeq,
  listConversationEvents as defaultListEvents,
  type ConversationEventRow,
} from '@pc/db';

import type { ReplayEnvelopeLike, SessionReplayCheckpointLike } from './adapters.ts';

export interface TranscriptCheckpointQuery {
  projectId: string;
  sessionId: string;
}

export interface TranscriptAfterSeqArgs extends TranscriptCheckpointQuery {
  /** Only rows with `seq > afterSeq` are returned. `0` == the full checkpoint. */
  afterSeq: number;
  /** Optional cap on the returned row count (oldest-first). */
  limit?: number;
}

export interface TranscriptRepository {
  loadCheckpoint(query: TranscriptCheckpointQuery): SessionReplayCheckpointLike;
  listAfter(args: TranscriptAfterSeqArgs): SessionReplayCheckpointLike;
}

export interface DbTranscriptRepositoryDeps {
  listEvents?: typeof defaultListEvents;
  getHighWaterSeq?: typeof defaultGetHighWaterSeq;
}

export class DbTranscriptRepository implements TranscriptRepository {
  private readonly listEvents: typeof defaultListEvents;
  private readonly getHighWaterSeq: typeof defaultGetHighWaterSeq;

  constructor(deps: DbTranscriptRepositoryDeps = {}) {
    this.listEvents = deps.listEvents ?? defaultListEvents;
    this.getHighWaterSeq = deps.getHighWaterSeq ?? defaultGetHighWaterSeq;
  }

  loadCheckpoint(query: TranscriptCheckpointQuery): SessionReplayCheckpointLike {
    const rows = this.listEvents(query.sessionId);
    return {
      sessionId: query.sessionId,
      highWaterSeq: rows.length > 0 ? rows[rows.length - 1]!.seq : 0,
      events: rows.map(toReplayEnvelope),
    };
  }

  listAfter(args: TranscriptAfterSeqArgs): SessionReplayCheckpointLike {
    const afterSeq = Number.isSafeInteger(args.afterSeq) && args.afterSeq > 0 ? args.afterSeq : 0;
    const rows = this.listEvents(args.sessionId, {
      ...(afterSeq > 0 ? { afterSeq } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    return {
      sessionId: args.sessionId,
      // Stable across reconnect — the FULL session high water, not the page's.
      highWaterSeq: this.getHighWaterSeq(args.sessionId),
      events: rows.map(toReplayEnvelope),
    };
  }
}

function toReplayEnvelope(row: ConversationEventRow): ReplayEnvelopeLike {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    type: row.type === 'event' ? 'event' : 'jsonl',
    kind: row.kind,
    event: row.event,
    source: {
      kind: row.sourceKind === 'legacy-events-jsonl' ? 'legacy-events-jsonl' : 'claude-jsonl',
      cursor: row.sourceCursor,
    },
  };
}
