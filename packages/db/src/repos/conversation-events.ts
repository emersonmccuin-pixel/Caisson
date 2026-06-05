// M3b — conversation_events repo: the orchestrator chat's replay store.
//
// ONE writer (OrchestratorHostSession.persistJsonlEvent → appendConversationEvent)
// + the boot backfill importer. Reads serve the replay surfaces (Sessions tab,
// WS connect snapshot, ?afterSeq cursor) through the DbTranscriptRepository.
// Plain repo door — NO live_outbox row: live delivery already rides the WS
// jsonl-event channel; this table is the history read-model only.

import { and, asc, count, eq, gt, max } from 'drizzle-orm';

import { getDb } from '../connection.ts';
import { conversationEvents } from '../schema.ts';

export type ConversationEventRow = typeof conversationEvents.$inferSelect;

export interface AppendConversationEventInput {
  sessionId: string;
  seq: number;
  type: 'jsonl' | 'event';
  kind: string | null;
  event: unknown;
  sourceKind: string;
  sourceCursor: number | null;
  now: number;
}

/** Append one replay event. `id` = `<sessionId>:<seq>` (the envelope id the UI
 *  keys on). The UNIQUE (session_id, seq) index makes a double-write throw —
 *  the caller's seq allocation is the authority. */
export function appendConversationEvent(input: AppendConversationEventInput): ConversationEventRow {
  const row = {
    id: `${input.sessionId}:${input.seq}`,
    sessionId: input.sessionId,
    seq: input.seq,
    type: input.type,
    kind: input.kind,
    event: input.event,
    sourceKind: input.sourceKind,
    sourceCursor: input.sourceCursor,
    createdAt: input.now,
  };
  getDb().insert(conversationEvents).values(row).run();
  return row;
}

/** Bulk import (boot backfill) — one txn per session. */
export function appendConversationEvents(rows: readonly AppendConversationEventInput[]): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  db.transaction((tx) => {
    for (const input of rows) {
      tx.insert(conversationEvents)
        .values({
          id: `${input.sessionId}:${input.seq}`,
          sessionId: input.sessionId,
          seq: input.seq,
          type: input.type,
          kind: input.kind,
          event: input.event,
          sourceKind: input.sourceKind,
          sourceCursor: input.sourceCursor,
          createdAt: input.now,
        })
        .run();
    }
  });
  return rows.length;
}

/** Writer resume state: next free seq + the highest persisted source cursor
 *  (the G7 dedup floor). Replaces the old file scan. */
export function getConversationReplayState(sessionId: string): {
  nextSeq: number;
  maxCursor: number;
} {
  const row = getDb()
    .select({ maxSeq: max(conversationEvents.seq), maxCursor: max(conversationEvents.sourceCursor) })
    .from(conversationEvents)
    .where(eq(conversationEvents.sessionId, sessionId))
    .get();
  return {
    nextSeq: (row?.maxSeq ?? 0) + 1,
    maxCursor: row?.maxCursor ?? 0,
  };
}

/** Replay read: a session's events ordered by seq; `afterSeq` returns only
 *  rows past the cursor; `limit` caps oldest-first. */
export function listConversationEvents(
  sessionId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): ConversationEventRow[] {
  const afterSeq =
    opts.afterSeq !== undefined && Number.isSafeInteger(opts.afterSeq) && opts.afterSeq > 0
      ? opts.afterSeq
      : null;
  const where = afterSeq === null
    ? eq(conversationEvents.sessionId, sessionId)
    : and(eq(conversationEvents.sessionId, sessionId), gt(conversationEvents.seq, afterSeq));
  const base = getDb()
    .select()
    .from(conversationEvents)
    .where(where)
    .orderBy(asc(conversationEvents.seq));
  const limited =
    opts.limit !== undefined && Number.isSafeInteger(opts.limit) && opts.limit > 0
      ? base.limit(opts.limit)
      : base;
  return limited.all();
}

/** The session's replay high water (0 when empty). Stable across afterSeq
 *  reads — reconnect contracts depend on it. */
export function getConversationHighWaterSeq(sessionId: string): number {
  const row = getDb()
    .select({ maxSeq: max(conversationEvents.seq) })
    .from(conversationEvents)
    .where(eq(conversationEvents.sessionId, sessionId))
    .get();
  return row?.maxSeq ?? 0;
}

/** Row count (the runtime snapshot's replayLineCount diagnostic). */
export function countConversationEvents(sessionId: string): number {
  const row = getDb()
    .select({ n: count() })
    .from(conversationEvents)
    .where(eq(conversationEvents.sessionId, sessionId))
    .get();
  return row?.n ?? 0;
}

/** Backfill guard: true once ANY row exists for the session. */
export function hasConversationEvents(sessionId: string): boolean {
  const row = getDb()
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(eq(conversationEvents.sessionId, sessionId))
    .limit(1)
    .get();
  return row !== undefined;
}
