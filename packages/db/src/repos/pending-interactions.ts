// Slice 007 — pending_interactions repo.
//
// General cross-system ask/review/approval state, separate from mailbox
// delivery. The first writer this slice is the /api/ask ask-shadow. Status
// transitions bump `version` for live-event stale-update guards. Terminalizing
// transitions are atomic `WHERE status='open'` flips (replay-safe).

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import type { DbExecutor } from '../connection.ts';
import { pendingInteractions } from '../schema.ts';

export type PendingInteractionRow = typeof pendingInteractions.$inferSelect;

export interface CreatePendingInteractionInput {
  id: ULID;
  projectId: ULID;
  kind: string;
  sourceKind: string;
  sourceId: string;
  sourceRef?: Record<string, unknown> | null;
  prompt: string;
  context?: string | null;
  options?: { value: string; label: string }[] | null;
  expiresAt?: number | null;
  now: number;
}

export function createPendingInteraction(
  input: CreatePendingInteractionInput,
  db: DbExecutor = getDb(),
): PendingInteractionRow {
  db.insert(pendingInteractions)
    .values({
      id: input.id,
      projectId: input.projectId,
      kind: input.kind,
      status: 'open',
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourceRef: input.sourceRef ?? null,
      prompt: input.prompt,
      context: input.context ?? null,
      options: input.options ?? null,
      answerBody: null,
      answeredBy: null,
      createdAt: input.now,
      updatedAt: input.now,
      answeredAt: null,
      cancelledAt: null,
      expiresAt: input.expiresAt ?? null,
      version: 1,
    })
    .run();
  return getPendingInteraction(input.id, db)!;
}

export function getPendingInteraction(
  id: ULID,
  db: DbExecutor = getDb(),
): PendingInteractionRow | null {
  return db.select().from(pendingInteractions).where(eq(pendingInteractions.id, id)).get() ?? null;
}

export function listPendingInteractionsForProject(
  projectId: ULID,
  db: DbExecutor = getDb(),
): PendingInteractionRow[] {
  return db
    .select()
    .from(pendingInteractions)
    .where(eq(pendingInteractions.projectId, projectId))
    .orderBy(asc(pendingInteractions.createdAt))
    .all();
}

/** Open rows across all projects (boot-sweep, inspector). */
export function listOpenPendingInteractions(db: DbExecutor = getDb()): PendingInteractionRow[] {
  return db
    .select()
    .from(pendingInteractions)
    .where(eq(pendingInteractions.status, 'open'))
    .orderBy(asc(pendingInteractions.createdAt))
    .all();
}

export interface AnswerPendingInteractionInput {
  id: ULID;
  answer: string;
  answeredBy: 'orchestrator' | 'user';
  now: number;
}

/** Atomic `open → answered` flip + version bump. Returns the post-write row if
 *  THIS call flipped it, else null (already terminal / replayed no-op). */
export function answerPendingInteraction(
  input: AnswerPendingInteractionInput,
  db: DbExecutor = getDb(),
): PendingInteractionRow | null {
  const res = db
    .update(pendingInteractions)
    .set({
      status: 'answered',
      answerBody: input.answer,
      answeredBy: input.answeredBy,
      answeredAt: input.now,
      updatedAt: input.now,
      version: bumpVersionSql(),
    })
    .where(and(eq(pendingInteractions.id, input.id), eq(pendingInteractions.status, 'open')))
    .run();
  return res.changes > 0 ? getPendingInteraction(input.id, db) : null;
}

/** Atomic `open → cancelled` flip + version bump. */
export function cancelPendingInteraction(
  id: ULID,
  now: number,
  db: DbExecutor = getDb(),
): PendingInteractionRow | null {
  const res = db
    .update(pendingInteractions)
    .set({ status: 'cancelled', cancelledAt: now, updatedAt: now, version: bumpVersionSql() })
    .where(and(eq(pendingInteractions.id, id), eq(pendingInteractions.status, 'open')))
    .run();
  return res.changes > 0 ? getPendingInteraction(id, db) : null;
}

/** Atomic `open → expired` flip + version bump. */
export function expirePendingInteraction(
  id: ULID,
  now: number,
  db: DbExecutor = getDb(),
): PendingInteractionRow | null {
  const res = db
    .update(pendingInteractions)
    .set({ status: 'expired', updatedAt: now, version: bumpVersionSql() })
    .where(and(eq(pendingInteractions.id, id), eq(pendingInteractions.status, 'open')))
    .run();
  return res.changes > 0 ? getPendingInteraction(id, db) : null;
}

/** Boot-sweep: expire every orphaned `open` row. Returns the ids swept. */
export function expireOpenPendingInteractions(now: number, db: DbExecutor = getDb()): ULID[] {
  const open = listOpenPendingInteractions(db);
  const swept: ULID[] = [];
  for (const row of open) {
    if (expirePendingInteraction(row.id, now, db)) swept.push(row.id);
  }
  return swept;
}

/** Look up an open interaction by its source (e.g. a runtime-hook toolUseId). */
export function findOpenPendingInteractionBySource(
  sourceKind: string,
  sourceId: string,
  db: DbExecutor = getDb(),
): PendingInteractionRow | null {
  return (
    db
      .select()
      .from(pendingInteractions)
      .where(
        and(
          eq(pendingInteractions.sourceKind, sourceKind),
          eq(pendingInteractions.sourceId, sourceId),
          inArray(pendingInteractions.status, ['open']),
        ),
      )
      .orderBy(asc(pendingInteractions.createdAt))
      .get() ?? null
  );
}

function bumpVersionSql() {
  return sql`${pendingInteractions.version} + 1`;
}
