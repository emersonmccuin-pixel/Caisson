// Area service (slice 010) — the durable write door for Areas.
//
// Mirrors the work-item mutation gateway: each mutation runs the repo write +
// `insertLiveEvent(tx, draft)` an `area.changed` row in the SAME transaction.
// The live-relay drains the committed row and fans the canonical frame by
// scope ('project') — fully automatic. No broadcast / fanout here.
//
// Boundary purity: imports only @pc/contracts, @pc/db, @pc/domain.

import type {
  AreaChangedLivePayload,
  AreaDto,
  AreaMutationReason,
  ULID,
} from '@pc/contracts';
import {
  createAreaInDb,
  getDb,
  insertLiveEvent,
  listAreasInDb,
  patchAreaInDb,
  reorderAreasInDb,
  softDeleteAreaInDb,
  type AreaRow,
  type DbExecutor,
  type InsertLiveEventDraft,
} from '@pc/db';
import type { ULID as DomainULID } from '@pc/domain';

export function toAreaDto(row: AreaRow): AreaDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    summary: row.summary,
    sortOrder: row.sortOrder,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** Build the canonical `area.changed` outbox draft. Single-area mutations
 *  carry `area` + the area's version; reorder carries `areas` + version null
 *  + entityId null (the list changed, not one row). */
export function buildAreaChangedDraft(input: {
  projectId: ULID;
  reason: AreaMutationReason;
  area?: AreaDto;
  areas?: AreaDto[];
}): InsertLiveEventDraft<AreaChangedLivePayload> {
  const payload: AreaChangedLivePayload = { reason: input.reason };
  if (input.area) payload.area = input.area;
  if (input.areas) payload.areas = input.areas;
  return {
    scope: 'project',
    projectId: input.projectId as DomainULID,
    type: 'area.changed',
    entity: 'area',
    entityId: input.area ? (input.area.id as DomainULID) : null,
    version: input.area ? input.area.version : null,
    payload,
  };
}

export interface AreaServiceDeps {
  /** Single transaction door. Defaults to the live DB; tests inject a fake. */
  transaction?: <T>(fn: (tx: DbExecutor) => T) => T;
  /** Insert a live-outbox row inside the transaction. Defaults to @pc/db. */
  insertLiveEvent?: typeof insertLiveEvent;
}

export class AreaService {
  private readonly tx: <T>(fn: (tx: DbExecutor) => T) => T;
  private readonly insert: typeof insertLiveEvent;

  constructor(deps: AreaServiceDeps = {}) {
    this.tx = deps.transaction ?? ((fn) => getDb().transaction(fn));
    this.insert = deps.insertLiveEvent ?? insertLiveEvent;
  }

  /** Read-only list. No event. */
  list(projectId: ULID): AreaDto[] {
    return listAreasInDb(getDb(), projectId as DomainULID).map(toAreaDto);
  }

  create(input: { projectId: ULID; name: string; summary?: string }): AreaDto {
    return this.tx((tx) => {
      const row = createAreaInDb(tx, {
        projectId: input.projectId as DomainULID,
        name: input.name,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      });
      const area = toAreaDto(row);
      this.insert(tx, buildAreaChangedDraft({ projectId: input.projectId, reason: 'created', area }));
      return area;
    });
  }

  /** Patch name/summary. Returns null when the area is gone / soft-deleted. */
  patch(input: {
    projectId: ULID;
    id: ULID;
    name?: string;
    summary?: string;
  }): AreaDto | null {
    return this.tx((tx) => {
      const row = patchAreaInDb(tx, input.id as DomainULID, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      });
      if (!row) return null;
      const area = toAreaDto(row);
      this.insert(tx, buildAreaChangedDraft({ projectId: input.projectId, reason: 'patched', area }));
      return area;
    });
  }

  /** Drag-reorder. Emits a list-shaped `reordered` fact carrying the full
   *  ordered set. */
  reorder(input: { projectId: ULID; orderedIds: ULID[] }): AreaDto[] {
    return this.tx((tx) => {
      const rows = reorderAreasInDb(tx, input.projectId as DomainULID, input.orderedIds as DomainULID[]);
      const areas = rows.map(toAreaDto);
      this.insert(
        tx,
        buildAreaChangedDraft({ projectId: input.projectId, reason: 'reordered', areas }),
      );
      return areas;
    });
  }

  /** Soft-delete; member work items fall back to Uncaptured. Emits a
   *  `deleted` fact carrying the (now soft-deleted) area row. Returns null
   *  when no such area. NOTE: the member work_items reassignment bumps each
   *  item's version inside the same tx but does NOT emit work-item.changed
   *  facts — the web filter rail reacts to the area.changed `deleted` fact +
   *  refetches Uncaptured. (Per-item facts on bulk reassign are deferred.) */
  softDelete(input: { projectId: ULID; id: ULID }): AreaDto | null {
    return this.tx((tx) => {
      const row = softDeleteAreaInDb(tx, input.id as DomainULID);
      if (!row) return null;
      const area = toAreaDto(row);
      this.insert(tx, buildAreaChangedDraft({ projectId: input.projectId, reason: 'deleted', area }));
      return area;
    });
  }
}
