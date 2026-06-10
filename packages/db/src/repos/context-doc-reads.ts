// Migration 0056 — context-doc read receipts (staleness/usage tracking).
//
// Two writers: (1) dispatch records 'injection' rows for every doc whose BODY
// the context chain inlined into the spawn prompt; (2) the single-doc GET
// routes record 'tool' rows when the request carries readVia=tool (the
// pc_get_context_doc handler appends it; UI fetches never do). Recording is
// best-effort everywhere — callers wrap in try/catch so a receipt failure can
// never fail a spawn or a read.

import { eq, inArray, max, sql } from 'drizzle-orm';
import type { ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { contextDocReads } from '../schema.ts';

export type ContextDocReadVia = 'injection' | 'tool';
export type ContextDocSessionKind = 'agent-run' | 'orchestrator';

export interface RecordContextDocReadsInput {
  docIds: readonly ULID[];
  agentRunId?: ULID | null;
  sessionKind: ContextDocSessionKind;
  readVia: ContextDocReadVia;
}

export interface ContextDocReadStats {
  readCount: number;
  lastReadAt: number;
}

/** Batch-insert one receipt per doc id. No-op on an empty list. */
export function recordContextDocReads(input: RecordContextDocReadsInput): void {
  if (input.docIds.length === 0) return;
  const now = Date.now();
  const rows = input.docIds.map((docId) => ({
    id: newId() as ULID,
    docId,
    agentRunId: input.agentRunId ?? null,
    sessionKind: input.sessionKind,
    readVia: input.readVia,
    readAt: now,
  }));
  getDb().insert(contextDocReads).values(rows).run();
}

/** Aggregate read stats for a set of docs. Docs with zero reads are absent
 *  from the map ("never read" = no entry). */
export function getContextDocReadStats(
  docIds: readonly ULID[],
): Map<ULID, ContextDocReadStats> {
  const out = new Map<ULID, ContextDocReadStats>();
  if (docIds.length === 0) return out;
  const rows = getDb()
    .select({
      docId: contextDocReads.docId,
      readCount: sql<number>`COUNT(*)`,
      lastReadAt: max(contextDocReads.readAt),
    })
    .from(contextDocReads)
    .where(inArray(contextDocReads.docId, [...docIds]))
    .groupBy(contextDocReads.docId)
    .all();
  for (const r of rows) {
    out.set(r.docId as ULID, { readCount: r.readCount, lastReadAt: r.lastReadAt ?? 0 });
  }
  return out;
}

/** Receipts for one run (debugging / future continuation-drift reasoning). */
export function listContextDocReadsForRun(agentRunId: ULID) {
  return getDb()
    .select()
    .from(contextDocReads)
    .where(eq(contextDocReads.agentRunId, agentRunId))
    .all();
}
