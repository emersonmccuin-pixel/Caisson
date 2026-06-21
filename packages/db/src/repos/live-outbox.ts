import { and, asc, desc, eq, gt, lt, lte, min, max, or } from 'drizzle-orm';
import type { ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import type { DbExecutor } from '../connection.ts';
import { newId } from '../id.ts';
import { liveOutbox } from '../schema.ts';

export type LiveOutboxScope = 'global' | 'project';
export type LiveOutboxEntity =
  | 'project'
  | 'project-claude-md'
  | 'work-item'
  | 'stage'
  | 'field-schema'
  | 'attachment'
  | 'workflow-definition'
  | 'workflow-run'
  | 'workflow-run-event'
  | 'workflow-review'
  | 'agent-run'
  | 'mailbox-message'
  | 'session-title'
  | 'pod'
  | 'area'
  | 'contract'
  | 'host-health'
  | 'context-doc'
  | 'work-item-dossier';

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
  /** Slice 015a — the requested `after` cursor predates the pruned floor, so the
   *  replay window is incomplete. The caller must drop its cursor and refetch
   *  HTTP truth for the affected domain(s) rather than trust a partial replay. */
  resetRequired?: boolean;
}

export interface PruneLiveOutboxInput {
  /** Keep at most this many of the newest rows (by `seq`). */
  maxRows?: number;
  /** Drop rows older than this many ms (by `createdAt`). */
  maxAgeMs?: number;
  now?: number;
}

export interface PruneLiveOutboxResult {
  deleted: number;
  /** Lowest surviving `seq` after the prune (the new floor), or null if empty. */
  floor: number | null;
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

  // Slice 015a — gap detection. The outbox is a prunable delivery buffer, not an
  // event store. If the requested cursor predates the oldest surviving row, the
  // window `(after, floor)` was pruned away and the replay would silently skip
  // rows. Signal `resetRequired` so the client falls back to a full-domain HTTP
  // reload instead of trusting an incomplete replay.
  //   - floor = min surviving seq. A cursor < (floor - 1) means at least one row
  //     after `after` is already gone (rows are gapless, so the first row we
  //     would replay is `after + 1`; if that is below `floor`, it was pruned).
  const floor = getLiveEventFloorSeq(db);
  if (floor !== null && afterSeq + 1 < floor) {
    return { events: [], nextCursor: getLiveEventHighWater(db), resetRequired: true };
  }

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

/**
 * T2.3 — the single most-recent row for an entity, as a fully-formed event.
 * Powers the cold-load seed for last-write-wins global entities (host-health):
 * the replay route is catch-up-from-cursor (returns nothing without a prior
 * cursor), so a fresh page load needs this "current state" snapshot instead.
 * Null when the entity has never emitted (e.g. host-health before the first
 * connection transition).
 */
export function getLatestLiveEventForEntity<TPayload = unknown>(
  entity: LiveOutboxEntity,
  db: DbExecutor = getDb(),
): LiveOutboxEvent<TPayload> | null {
  const row = db
    .select()
    .from(liveOutbox)
    .where(eq(liveOutbox.entity, entity))
    .orderBy(desc(liveOutbox.seq))
    .limit(1)
    .get();
  return row ? rowToEvent<TPayload>(row) : null;
}

/**
 * Slice 015a — raw drain read for the relay. Returns ALL committed rows (both
 * `global` and `project` scope) with `seq > after`, ordered by `seq`, capped at
 * `limit`. Unlike `listLiveEventsAfter` (which the replay route uses and which
 * filters to a single scope/project), the relay needs the mixed stream so it can
 * route each row by its own scope to the right subscribers.
 */
export function listLiveOutboxRowsAfter(
  after: string,
  limit: number,
  db: DbExecutor = getDb(),
): LiveOutboxEvent[] {
  const afterSeq = parseCursor(after);
  const rows = db
    .select()
    .from(liveOutbox)
    .where(gt(liveOutbox.seq, afterSeq))
    .orderBy(asc(liveOutbox.seq))
    .limit(clampLimit(limit))
    .all();
  return rows.map((row) => rowToEvent(row));
}

export function getLiveEventHighWater(db: DbExecutor = getDb()): string | null {
  const row = db.select({ value: max(liveOutbox.seq) }).from(liveOutbox).get() as
    | { value: number | null }
    | undefined;
  return row?.value === null || row?.value === undefined ? null : String(row.value);
}

/** Lowest surviving `seq` in the outbox (the prune floor), or null if empty. */
export function getLiveEventFloor(db: DbExecutor = getDb()): string | null {
  const value = getLiveEventFloorSeq(db);
  return value === null ? null : String(value);
}

function getLiveEventFloorSeq(db: DbExecutor): number | null {
  const row = db.select({ value: min(liveOutbox.seq) }).from(liveOutbox).get() as
    | { value: number | null }
    | undefined;
  return row?.value === null || row?.value === undefined ? null : row.value;
}

/**
 * Slice 015a — prune the outbox by size and/or age. The outbox is a transient
 * delivery buffer (ADR: "not an event store"); prune by fixed size/age, never by
 * a live-cursor watermark. When both bounds are given, a row is dropped if it
 * fails EITHER bound (whichever hits first), so the window stays under both.
 * Additive: never rewrites surviving rows; `seq` stays monotonic (no reuse).
 * A reconnecting client whose cursor predates the new floor self-heals via the
 * `resetRequired` path (full-domain reload).
 */
export function pruneLiveOutbox(
  input: PruneLiveOutboxInput = {},
  db: DbExecutor = getDb(),
): PruneLiveOutboxResult {
  let deleted = 0;

  if (input.maxAgeMs !== undefined && input.maxAgeMs >= 0) {
    const cutoff = (input.now ?? Date.now()) - input.maxAgeMs;
    const res = db.delete(liveOutbox).where(lt(liveOutbox.createdAt, cutoff)).run();
    deleted += Number(res.changes ?? 0);
  }

  if (input.maxRows !== undefined && input.maxRows >= 0) {
    // Keep the newest `maxRows` rows. Order newest-first and read the row at
    // offset `maxRows` — that is the newest row to EVICT (the (maxRows+1)-th
    // newest). Delete everything with seq <= it. If fewer than `maxRows` rows
    // exist the offset yields nothing and we delete nothing.
    const boundary = db
      .select({ seq: liveOutbox.seq })
      .from(liveOutbox)
      .orderBy(desc(liveOutbox.seq))
      .limit(1)
      .offset(input.maxRows)
      .all() as Array<{ seq: number }>;
    if (boundary.length > 0) {
      const evictAtOrBelow = boundary[0].seq;
      const res = db.delete(liveOutbox).where(lte(liveOutbox.seq, evictAtOrBelow)).run();
      deleted += Number(res.changes ?? 0);
    }
  }

  return { deleted, floor: getLiveEventFloorSeq(db) };
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
