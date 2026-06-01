// Slice 010 — Areas repo. Persistence-only (no outbox writes — the
// app-services AreaService announces). Mirrors repos/projects.ts: DbExecutor-
// injectable `*InDb` variants + getDb() wrappers.

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import type { DbExecutor } from '../connection.ts';
import { newId } from '../id.ts';
import { areas, workItems } from '../schema.ts';

export interface AreaRow {
  id: ULID;
  projectId: ULID;
  name: string;
  summary: string;
  sortOrder: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface CreateAreaInput {
  id?: ULID;
  projectId: ULID;
  name: string;
  summary?: string;
}

export interface PatchAreaInput {
  name?: string;
  summary?: string;
}

export interface ListAreasOptions {
  /** Include soft-deleted rows. Off by default. */
  includeDeleted?: boolean;
}

export function listAreas(projectId: ULID, opts: ListAreasOptions = {}): AreaRow[] {
  return listAreasInDb(getDb(), projectId, opts);
}

export function listAreasInDb(
  db: DbExecutor,
  projectId: ULID,
  opts: ListAreasOptions = {},
): AreaRow[] {
  const base = and(eq(areas.projectId, projectId), opts.includeDeleted ? undefined : isNull(areas.deletedAt));
  return db
    .select()
    .from(areas)
    .where(base)
    .orderBy(asc(areas.sortOrder), asc(areas.createdAt))
    .all() as AreaRow[];
}

export function getArea(id: ULID): AreaRow | null {
  return getAreaInDb(getDb(), id);
}

export function getAreaInDb(db: DbExecutor, id: ULID): AreaRow | null {
  const row = db.select().from(areas).where(eq(areas.id, id)).get() as AreaRow | undefined;
  return row ?? null;
}

export function createArea(input: CreateAreaInput): AreaRow {
  return createAreaInDb(getDb(), input);
}

export function createAreaInDb(db: DbExecutor, input: CreateAreaInput): AreaRow {
  const now = Date.now();
  const id = input.id ?? newId();
  // New areas append at the bottom. Soft-deleted rows still count toward
  // max(sort_order) so the order space stays gap-free across deletes.
  const maxRow = db
    .select({ v: sql<number | null>`max(${areas.sortOrder})` })
    .from(areas)
    .where(eq(areas.projectId, input.projectId))
    .get() as { v: number | null } | undefined;
  const sortOrder = (maxRow?.v ?? -1) + 1;
  const row: AreaRow = {
    id,
    projectId: input.projectId,
    name: input.name,
    summary: input.summary ?? '',
    sortOrder,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  db.insert(areas).values(row).run();
  return row;
}

export function patchArea(id: ULID, input: PatchAreaInput): AreaRow | null {
  return patchAreaInDb(getDb(), id, input);
}

export function patchAreaInDb(db: DbExecutor, id: ULID, input: PatchAreaInput): AreaRow | null {
  const existing = getAreaInDb(db, id);
  if (!existing || existing.deletedAt !== null) return null;
  if (input.name === undefined && input.summary === undefined) return existing;
  const now = Date.now();
  const patch: { name?: string; summary?: string; version: number; updatedAt: number } = {
    version: existing.version + 1,
    updatedAt: now,
  };
  if (input.name !== undefined) patch.name = input.name;
  if (input.summary !== undefined) patch.summary = input.summary;
  db.update(areas).set(patch).where(eq(areas.id, id)).run();
  return getAreaInDb(db, id);
}

/** Drag-reorder. Rewrites `sort_order` 0..N-1 for the given ids in order.
 *  Clamps against live rows of that project (a stale list can't promote a
 *  deleted/foreign row). Bumps version + updatedAt per rewritten row. */
export function reorderAreas(projectId: ULID, orderedIds: ULID[]): AreaRow[] {
  const db = getDb();
  return db.transaction((tx) => reorderAreasInDb(tx, projectId, orderedIds));
}

export function reorderAreasInDb(
  db: DbExecutor,
  projectId: ULID,
  orderedIds: ULID[],
): AreaRow[] {
  if (orderedIds.length > 0) {
    const live = (db
      .select({ id: areas.id })
      .from(areas)
      .where(
        and(eq(areas.projectId, projectId), isNull(areas.deletedAt), inArray(areas.id, orderedIds)),
      )
      .all() as { id: ULID }[]).map((r) => r.id);
    const liveSet = new Set(live);
    const finalOrder = orderedIds.filter((id) => liveSet.has(id));
    const now = Date.now();
    finalOrder.forEach((id, idx) => {
      db.update(areas)
        .set({ sortOrder: idx, version: sql`${areas.version} + 1`, updatedAt: now })
        .where(eq(areas.id, id))
        .run();
    });
  }
  return listAreasInDb(db, projectId);
}

/** Soft-delete an area: flip `deleted_at`, AND set `area_id = NULL` on every
 *  work_items row in that project pointing at this area (fall-back-to-
 *  Uncaptured). Bumps each reassigned work item's version + updatedAt so the
 *  live-relay stale-update guard re-renders them. Returns the area row, or
 *  null if no such area. Idempotent on an already-deleted area. */
export function softDeleteArea(id: ULID): AreaRow | null {
  const db = getDb();
  return db.transaction((tx) => softDeleteAreaInDb(tx, id));
}

export function softDeleteAreaInDb(db: DbExecutor, id: ULID): AreaRow | null {
  const existing = getAreaInDb(db, id);
  if (!existing) return null;
  const now = Date.now();
  if (existing.deletedAt === null) {
    db.update(areas)
      .set({ deletedAt: now, version: existing.version + 1, updatedAt: now })
      .where(eq(areas.id, id))
      .run();
  }
  // Member work items fall back to Uncaptured regardless (idempotent cleanup).
  db.update(workItems)
    .set({ areaId: null, version: sql`${workItems.version} + 1`, updatedAt: now })
    .where(and(eq(workItems.projectId, existing.projectId), eq(workItems.areaId, id)))
    .run();
  return getAreaInDb(db, id);
}

/** Point-write of a work item's `area_id`. Bumps version + updatedAt. Returns
 *  the affected work-item id when the row exists + the value changed, else null
 *  (no-op). The work-item-changed announcement is the caller's job. */
export function setWorkItemArea(workItemId: ULID, areaId: ULID | null): ULID | null {
  return setWorkItemAreaInDb(getDb(), workItemId, areaId);
}

export function setWorkItemAreaInDb(
  db: DbExecutor,
  workItemId: ULID,
  areaId: ULID | null,
): ULID | null {
  const now = Date.now();
  const res = db
    .update(workItems)
    .set({ areaId, version: sql`${workItems.version} + 1`, updatedAt: now })
    .where(and(eq(workItems.id, workItemId), isNull(workItems.deletedAt)))
    .run();
  return Number(res.changes ?? 0) > 0 ? workItemId : null;
}
