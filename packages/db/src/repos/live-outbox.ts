import { and, asc, eq, gt, max, or } from 'drizzle-orm';
import type { ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import type { DbExecutor } from '../connection.ts';
import { newId } from '../id.ts';
import { liveOutbox } from '../schema.ts';

export type LiveOutboxScope = 'global' | 'project';
export type LiveOutboxEntity =
  | 'project'
  | 'work-item'
  | 'stage'
  | 'field-schema'
  | 'attachment';

export interface InsertLiveEventDraft<TPayload = unknown> {
  id?: ULID;
  scope: LiveOutboxScope;
  projectId: ULID | null;
  type: string;
  entity: LiveOutboxEntity;
  entityId: ULID | null;
  version: number | null;
  payload: TPayload;
  createdAt?: number;
}

export interface LiveOutboxEvent<TPayload = unknown> {
  id: ULID;
  cursor: string;
  scope: LiveOutboxScope;
  projectId: ULID | null;
  type: string;
  entity: LiveOutboxEntity;
  entityId: ULID | null;
  version: number | null;
  createdAt: number;
  payload: TPayload;
}

export interface ListLiveEventsAfterInput {
  after?: string;
  projectId?: ULID;
  includeGlobal?: boolean;
  limit?: number;
  type?: string;
}

export interface ListLiveEventsAfterResult {
  events: LiveOutboxEvent[];
  nextCursor: string | null;
}

export class LiveEventCursorError extends Error {
  constructor(cursor: string) {
    super(`invalid live event cursor: ${cursor}`);
  }
}

export function insertLiveEvent<TPayload>(
  db: DbExecutor,
  draft: InsertLiveEventDraft<TPayload>,
): LiveOutboxEvent<TPayload> {
  assertScopeProjectInvariant(draft.scope, draft.projectId);
  const id = draft.id ?? newId();
  db.insert(liveOutbox)
    .values({
      id,
      scope: draft.scope,
      projectId: draft.projectId,
      type: draft.type,
      entity: draft.entity,
      entityId: draft.entityId,
      version: draft.version,
      payload: draft.payload as Record<string, unknown>,
      createdAt: draft.createdAt ?? Date.now(),
      publishedAt: null,
    })
    .run();
  const row = db.select().from(liveOutbox).where(eq(liveOutbox.id, id)).get();
  if (!row) throw new Error(`live outbox insert disappeared: ${id}`);
  return rowToEvent<TPayload>(row);
}

export function listLiveEventsAfter(
  input: ListLiveEventsAfterInput = {},
  db: DbExecutor = getDb(),
): ListLiveEventsAfterResult {
  const limit = clampLimit(input.limit);
  if (input.after === undefined) {
    return { events: [], nextCursor: getLiveEventHighWater(db) };
  }

  const afterSeq = parseCursor(input.after);
  const conditions = [gt(liveOutbox.seq, afterSeq)];
  if (input.type) conditions.push(eq(liveOutbox.type, input.type));

  if (input.projectId) {
    const scoped = and(eq(liveOutbox.scope, 'project'), eq(liveOutbox.projectId, input.projectId));
    conditions.push(input.includeGlobal ? or(eq(liveOutbox.scope, 'global'), scoped)! : scoped!);
  } else {
    conditions.push(eq(liveOutbox.scope, 'global'));
  }

  const rows = db
    .select()
    .from(liveOutbox)
    .where(and(...conditions))
    .orderBy(asc(liveOutbox.seq))
    .limit(limit)
    .all();
  const events = rows.map((row) => rowToEvent(row));
  return {
    events,
    nextCursor: events.at(-1)?.cursor ?? getLiveEventHighWater(db),
  };
}

export function getLiveEventHighWater(db: DbExecutor = getDb()): string | null {
  const row = db.select({ value: max(liveOutbox.seq) }).from(liveOutbox).get() as
    | { value: number | null }
    | undefined;
  return row?.value === null || row?.value === undefined ? null : String(row.value);
}

export function markLiveEventsPublished(
  ids: readonly ULID[],
  now = Date.now(),
  db: DbExecutor = getDb(),
): void {
  for (const id of ids) {
    db.update(liveOutbox).set({ publishedAt: now }).where(eq(liveOutbox.id, id)).run();
  }
}

function rowToEvent<TPayload = unknown>(
  row: typeof liveOutbox.$inferSelect,
): LiveOutboxEvent<TPayload> {
  return {
    id: row.id as ULID,
    cursor: String(row.seq),
    scope: row.scope,
    projectId: row.projectId,
    type: row.type,
    entity: row.entity,
    entityId: row.entityId,
    version: row.version,
    createdAt: row.createdAt,
    payload: row.payload as TPayload,
  };
}

function assertScopeProjectInvariant(scope: LiveOutboxScope, projectId: ULID | null): void {
  if (scope === 'global' && projectId !== null) {
    throw new Error('global live events must not carry projectId');
  }
  if (scope === 'project' && !projectId) {
    throw new Error('project live events require projectId');
  }
}

function parseCursor(cursor: string): number {
  if (!/^(0|[1-9]\d*)$/.test(cursor)) throw new LiveEventCursorError(cursor);
  const numeric = Number(cursor);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new LiveEventCursorError(cursor);
  return numeric;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100;
  const integer = Math.trunc(limit);
  if (integer < 1) return 1;
  if (integer > 500) return 500;
  return integer;
}
