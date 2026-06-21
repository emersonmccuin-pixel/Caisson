import { and, asc, eq, isNull, isNotNull, max, notInArray } from 'drizzle-orm';
import type {
  DoneChecklistItem,
  ULID,
  WorkItem,
  WorkItemHistoryEntry,
  WorkItemSlim,
  WorkItemStatus,
  WorkItemType,
} from '@pc/domain';
import { getDb, getRawDb } from '../connection.ts';
import { newId } from '../id.ts';
import { projects, workItems } from '../schema.ts';

// Slice 013 — a work item renders its associated contracts as a work log.
// Re-export the read so callers reaching for work-item data find it here.
export {
  listContractsForWorkItem,
  listContractsForWorkItemInDb,
} from './contracts.ts';

/** Optimistic-concurrency conflict. Server returns 409 + current row when this throws. */
export class WorkItemVersionConflictError extends Error {
  constructor(
    public readonly id: ULID,
    public readonly expected: number,
    public readonly actual: number,
    public readonly current: WorkItem,
  ) {
    super(`work item ${id} version conflict: expected ${expected}, got ${actual}`);
    this.name = 'WorkItemVersionConflictError';
  }
}

interface WorkItemRow {
  id: ULID;
  projectId: ULID;
  parentId: ULID | null;
  title: string;
  body: string;
  stageId: string;
  status: WorkItemStatus;
  statusReason: string | null;
  type: WorkItemType;
  fields: Record<string, unknown>;
  history: WorkItemHistoryEntry[];
  position: number;
  version: number;
  isWorkflowRoot: boolean;
  callsign: string | null;
  areaId: ULID | null;
  focusedAt: number | null;
  doneChecklist: DoneChecklistItem[] | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

function toDomain(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    position: row.position,
    title: row.title,
    body: row.body,
    stageId: row.stageId,
    status: row.status,
    statusReason: row.statusReason,
    type: row.type,
    fields: row.fields,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    history: row.history,
    isWorkflowRoot: row.isWorkflowRoot,
    callsign: row.callsign,
    areaId: row.areaId ?? null,
    focusedAt: row.focusedAt ?? null,
    doneChecklist: row.doneChecklist ?? null,
  };
}

export interface CreateWorkItemInput {
  projectId: ULID;
  stageId: string;
  title: string;
  body?: string;
  parentId?: ULID | null;
  position?: number;
  type?: WorkItemType;
  fields?: Record<string, unknown>;
  initialHistory?: WorkItemHistoryEntry[];
  /** Section 19 — mark this row a v2 workflow run root. Default false. */
  isWorkflowRoot?: boolean;
  /** Slice 010 — Area bucket FK, or null for Uncaptured. */
  areaId?: ULID | null;
  /** Initial Definition-of-Done checklist. Null/omitted = no checklist. */
  doneChecklist?: DoneChecklistItem[] | null;
}

/** Slice 010 — area filter for the work-item list. `'uncaptured'` or `null`
 *  filters `area_id IS NULL`; a ULID filters `area_id = ?`; omit for no
 *  area filtering. */
export type WorkItemAreaFilter = ULID | null | 'uncaptured';

/** Terminal statuses excluded by the `open: true` filter (pc-pty-chat-254). */
const CLOSED_STATUSES: WorkItemStatus[] = ['complete', 'cancelled', 'archived'];

export interface ListWorkItemsOptions {
  /** Slice 010 — narrow to one Area, or to Uncaptured. */
  areaId?: WorkItemAreaFilter;
  /** pc-pty-chat-254 — filter by exact status. */
  status?: WorkItemStatus;
  /** pc-pty-chat-254 — when true, exclude complete/cancelled/archived items.
   *  Mutually useful with `status` (e.g. open=true + status=blocked). */
  open?: boolean;
}

/** pc-pty-chat-254 — slim projection used by default in pc_list_work_items.
 *  Re-exported here so the route can import it without touching @pc/domain directly. */
export type { WorkItemSlim };

/** Map a full WorkItem row to its slim projection (pc-pty-chat-254). */
export function toSlimWorkItem(wi: WorkItem): WorkItemSlim {
  return {
    id: wi.id,
    projectId: wi.projectId,
    callsign: wi.callsign,
    title: wi.title,
    type: wi.type,
    status: wi.status,
    statusReason: wi.statusReason,
    stageId: wi.stageId,
    areaId: wi.areaId,
    parentId: wi.parentId,
    updatedAt: wi.updatedAt,
    focusedAt: wi.focusedAt,
  };
}

// ── Work-item FTS5 search (pc-pty-chat-254) ────────────────────────────────────

export interface SearchWorkItemsInput {
  projectId: ULID;
  query: string;
  /** Narrow to a specific area. */
  areaId?: ULID;
  /** Filter by exact status. */
  status?: WorkItemStatus;
  /** When true, exclude complete/cancelled/archived. */
  open?: boolean;
}

export interface WorkItemSearchResult {
  id: ULID;
  projectId: ULID;
  callsign: string | null;
  title: string;
  type: WorkItemType;
  status: WorkItemStatus;
  stageId: string;
  areaId: ULID | null;
  parentId: ULID | null;
  updatedAt: number;
  /** FTS5 snippet excerpt. */
  snippet: string;
}

/**
 * FTS5 full-text search across work_items in a project.
 * Uses getRawDb() — Drizzle cannot query virtual tables.
 * Mirrors searchContextDocs (migration 0049 / context-docs.ts).
 *
 * NOTE: `type` filter is deferred pending pc-pty-chat-285 (dual source-of-truth
 * for work-item type).
 */
export function searchWorkItems(input: SearchWorkItemsInput): WorkItemSearchResult[] {
  const raw = getRawDb();

  const fts5Available = (raw.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS v").get() as { v: number }).v;
  if (!fts5Available) throw new Error('FTS5 is not available in this SQLite build');

  const sanitized = sanitizeFts5QueryLocal(input.query);
  if (!sanitized) return [];

  const conditions: string[] = [
    'wi.deleted_at IS NULL',
    'wi.project_id = ?',
  ];
  const params: unknown[] = [input.projectId];

  if (input.areaId) {
    conditions.push('wi.area_id = ?');
    params.push(input.areaId);
  }
  if (input.status !== undefined) {
    conditions.push('wi.status = ?');
    params.push(input.status);
  }
  if (input.open === true) {
    conditions.push(`wi.status NOT IN ('complete', 'cancelled', 'archived')`);
  }

  const whereClause = conditions.join(' AND ');
  const sql = `
    SELECT wi.id, wi.project_id, wi.callsign, wi.title, wi.type, wi.status,
           wi.stage_id, wi.area_id, wi.parent_id, wi.updated_at,
           snippet(work_items_fts, 1, '<b>', '</b>', '…', 16) AS snippet
    FROM work_items_fts
    JOIN work_items wi ON work_items_fts.rowid = wi.rowid
    WHERE work_items_fts MATCH ?
      AND ${whereClause}
    ORDER BY rank
    LIMIT 50
  `;

  const rows = raw.prepare(sql).all([sanitized, ...params]) as Array<{
    id: string;
    project_id: string;
    callsign: string | null;
    title: string;
    type: string;
    status: string;
    stage_id: string;
    area_id: string | null;
    parent_id: string | null;
    updated_at: number;
    snippet: string;
  }>;

  return rows.map((r) => ({
    id: r.id as ULID,
    projectId: r.project_id as ULID,
    callsign: r.callsign,
    title: r.title,
    type: r.type as WorkItemType,
    status: r.status as WorkItemStatus,
    stageId: r.stage_id,
    areaId: (r.area_id as ULID) ?? null,
    parentId: (r.parent_id as ULID) ?? null,
    updatedAt: r.updated_at,
    snippet: r.snippet ?? '',
  }));
}

// ── Board health (pc-pty-chat-431) ────────────────────────────────────────────

export interface BoardHealthItem {
  id: ULID;
  callsign: string | null;
  title: string;
  stageId: string;
  status: WorkItemStatus;
  /** Days the item has been in its current stage (from last move-into-stage or creation). */
  ageInStageDays: number;
  /** Epoch ms of the newest signal across wi.updatedAt, linked contracts, and agent runs. */
  lastActivityAt: number;
}

export interface BoardHealthResult {
  stalledItems: BoardHealthItem[];
  rollup: {
    totalOpen: number;
    totalStalled: number;
  };
}

/**
 * Board health: stalled open work items for a project.
 *
 * "Stalled" = open (non-terminal, non-archived) work item with no activity for
 * >= idleDays. "Activity" = newest of:
 *   • work_item.updated_at
 *   • MAX agent_run.last_activity_at|completed_at|queued_at for runs
 *     whose contract links to this item (via agent_contracts.work_item_id)
 *   • MAX agent_run.last_activity_at|completed_at|queued_at for runs
 *     whose parent_work_item_id points at this item
 *   • MAX agent_contracts.updated_at for contracts linked to this item
 *
 * Uses getRawDb() (correlated subqueries across agent_runs + agent_contracts —
 * Drizzle's join API can't express the mixed-join pattern cleanly here).
 */
export function getBoardHealth(projectId: ULID, idleDays: number): BoardHealthResult {
  const raw = getRawDb();
  const now = Date.now();
  const idleMs = idleDays * 24 * 60 * 60 * 1000;
  const cutoff = now - idleMs;

  const sql = `
    SELECT
      wi.id,
      wi.callsign,
      wi.title,
      wi.stage_id      AS stageId,
      wi.status,
      wi.updated_at    AS updatedAt,
      wi.created_at    AS createdAt,
      wi.history       AS historyJson,
      COALESCE(
        (SELECT MAX(COALESCE(ar.last_activity_at, COALESCE(ar.completed_at, ar.queued_at)))
         FROM agent_runs ar
         INNER JOIN agent_contracts ac ON ar.contract_id = ac.id
         WHERE ac.work_item_id = wi.id
           AND ac.project_id   = wi.project_id),
        0
      ) AS maxRunViaContract,
      COALESCE(
        (SELECT MAX(COALESCE(ar.last_activity_at, COALESCE(ar.completed_at, ar.queued_at)))
         FROM agent_runs ar
         WHERE ar.parent_work_item_id = wi.id
           AND ar.project_id          = wi.project_id),
        0
      ) AS maxRunViaParent,
      COALESCE(
        (SELECT MAX(ac2.updated_at)
         FROM agent_contracts ac2
         WHERE ac2.work_item_id = wi.id
           AND ac2.project_id   = wi.project_id),
        0
      ) AS maxContractActivity
    FROM work_items wi
    WHERE wi.project_id = ?
      AND wi.status NOT IN ('complete', 'cancelled', 'archived')
      AND wi.deleted_at IS NULL
  `;

  const rows = raw.prepare(sql).all(projectId) as Array<{
    id: string;
    callsign: string | null;
    title: string;
    stageId: string;
    status: string;
    updatedAt: number;
    createdAt: number;
    historyJson: string | null;
    maxRunViaContract: number;
    maxRunViaParent: number;
    maxContractActivity: number;
  }>;

  const totalOpen = rows.length;
  const stalled: BoardHealthItem[] = [];

  for (const row of rows) {
    const lastActivityAt = Math.max(
      row.updatedAt,
      row.maxRunViaContract,
      row.maxRunViaParent,
      row.maxContractActivity,
    );

    if (lastActivityAt >= cutoff) continue; // active — not stalled

    // Age-in-stage: find the timestamp of the most recent move INTO this stage.
    // Falls back to createdAt when no move history exists.
    let stageEnteredAt = row.createdAt;
    if (row.historyJson) {
      try {
        const history = JSON.parse(row.historyJson) as Array<{
          ts?: string;
          kind?: string;
          to?: string;
        }>;
        for (const entry of history) {
          if (entry.kind === 'move' && entry.to === row.stageId && entry.ts) {
            const ts = new Date(entry.ts).getTime();
            if (Number.isFinite(ts) && ts > stageEnteredAt) {
              stageEnteredAt = ts;
            }
          }
        }
      } catch {
        // Malformed history — stageEnteredAt stays at createdAt
      }
    }

    const ageInStageDays = Math.max(0, Math.floor((now - stageEnteredAt) / (24 * 60 * 60 * 1000)));

    stalled.push({
      id: row.id as ULID,
      callsign: row.callsign,
      title: row.title,
      stageId: row.stageId,
      status: row.status as WorkItemStatus,
      ageInStageDays,
      lastActivityAt,
    });
  }

  // Oldest stall first so the caller sees the most-neglected items at the top.
  stalled.sort((a, b) => a.lastActivityAt - b.lastActivityAt);

  return {
    stalledItems: stalled,
    rollup: { totalOpen, totalStalled: stalled.length },
  };
}

/** Inline copy of sanitizeFts5Query (avoids cross-repo import cycle). */
function sanitizeFts5QueryLocal(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}

export function listWorkItems(projectId: ULID, opts: ListWorkItemsOptions = {}): WorkItem[] {
  const conditions = [eq(workItems.projectId, projectId), isNull(workItems.deletedAt)];
  if (opts.areaId !== undefined) {
    conditions.push(
      opts.areaId === null || opts.areaId === 'uncaptured'
        ? isNull(workItems.areaId)
        : eq(workItems.areaId, opts.areaId),
    );
  }
  if (opts.status !== undefined) {
    conditions.push(eq(workItems.status, opts.status));
  }
  if (opts.open === true) {
    conditions.push(notInArray(workItems.status, CLOSED_STATUSES));
  }
  const rows = getDb()
    .select()
    .from(workItems)
    .where(and(...conditions))
    .orderBy(asc(workItems.position), asc(workItems.createdAt))
    .all() as WorkItemRow[];
  return rows.map(toDomain);
}

export function getWorkItem(id: ULID): WorkItem | null {
  const row = getRowById(id);
  return row ? toDomain(row) : null;
}

function getRowById(id: ULID): WorkItemRow | null {
  const row = getDb()
    .select()
    .from(workItems)
    .where(and(eq(workItems.id, id), isNull(workItems.deletedAt)))
    .get() as WorkItemRow | undefined;
  return row ?? null;
}

function nextPosition(projectId: ULID, stageId: string, parentId: ULID | null): number {
  const row = getDb()
    .select({ max: max(workItems.position) })
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.stageId, stageId),
        parentId == null ? isNull(workItems.parentId) : eq(workItems.parentId, parentId),
        isNull(workItems.deletedAt),
      ),
    )
    .get() as { max: number | null } | undefined;
  return (row?.max ?? -1) + 1;
}

export function createWorkItem(input: CreateWorkItemInput): WorkItem {
  const now = Date.now();
  const id = newId();
  const parentId = input.parentId ?? null;
  const position = input.position ?? nextPosition(input.projectId, input.stageId, parentId);

  // Section 35 — claim a callsign in the same transaction as the insert so
  // concurrent creates can't race on the projects.callsign_seq bump or on
  // the per-parent suffix scan.
  const db = getDb();
  return db.transaction((tx) => {
    let callsign: string | null = null;
    {
      // A parent might be dangling/soft-deleted (no callsign). In that case the
      // new row is treated as an effective root and gets a top-level number.
      let parentCallsign: string | null = null;
      if (parentId != null) {
        const parentRow = tx
          .select({ callsign: workItems.callsign })
          .from(workItems)
          .where(eq(workItems.id, parentId))
          .get() as { callsign: string | null } | undefined;
        if (parentRow && parentRow.callsign != null) {
          parentCallsign = parentRow.callsign;
        }
      }
      if (parentCallsign == null) {
        const projectRow = tx
          .select({ slug: projects.slug, callsignSeq: projects.callsignSeq })
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .get() as { slug: string; callsignSeq: number } | undefined;
        if (projectRow) {
          const next = (projectRow.callsignSeq ?? 0) + 1;
          tx.update(projects)
            .set({ callsignSeq: next, updatedAt: now })
            .where(eq(projects.id, input.projectId))
            .run();
          callsign = `${projectRow.slug}-${next}`;
        }
      } else {
        // Per-parent next suffix = MAX(existing suffix) + 1 across all
        // siblings (live and archived) — never reuse a child number even
        // after a sibling is archived.
        const prefix = `${parentCallsign}.`;
        const siblings = tx
          .select({ callsign: workItems.callsign })
          .from(workItems)
          .where(and(eq(workItems.parentId, parentId!), isNotNull(workItems.callsign)))
          .all() as { callsign: string }[];
        let maxSuffix = 0;
        for (const s of siblings) {
          if (!s.callsign.startsWith(prefix)) continue;
          const tail = s.callsign.slice(prefix.length);
          // Skip deeper-nested callsigns (descendants of siblings).
          if (tail.includes('.')) continue;
          const n = Number.parseInt(tail, 10);
          if (Number.isFinite(n) && n > maxSuffix) maxSuffix = n;
        }
        callsign = `${parentCallsign}.${maxSuffix + 1}`;
      }
    }

    const row: WorkItemRow = {
      id,
      projectId: input.projectId,
      parentId,
      title: input.title,
      body: input.body ?? '',
      stageId: input.stageId,
      status: 'pending',
      statusReason: null,
      type: input.type ?? 'task',
      fields: input.fields ?? {},
      history: input.initialHistory ?? [],
      position,
      version: 1,
      isWorkflowRoot: input.isWorkflowRoot ?? false,
      callsign,
      areaId: input.areaId ?? null,
      focusedAt: null,
      doneChecklist: input.doneChecklist ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    tx.insert(workItems).values(row).run();
    return toDomain(row);
  });
}

/** Command focus — star/unstar a work item. `focused` true stamps `focused_at`
 *  with now; false clears it. Bumps version + updatedAt so live deltas refresh.
 *  Returns the updated WorkItem, or null if no such (live) item. */
export function setWorkItemFocus(id: ULID, focused: boolean): WorkItem | null {
  const db = getDb();
  const existing = db
    .select()
    .from(workItems)
    .where(and(eq(workItems.id, id), isNull(workItems.deletedAt)))
    .get() as WorkItemRow | undefined;
  if (!existing) return null;
  const now = Date.now();
  const focusedAt = focused ? now : null;
  const version = existing.version + 1;
  db
    .update(workItems)
    .set({ focusedAt, updatedAt: now, version })
    .where(eq(workItems.id, id))
    .run();
  return toDomain({ ...existing, focusedAt, updatedAt: now, version });
}

/** FOCUS — live work items with focusedAt set.
 *  Pass `projectId` to scope to a single project (regular-project Focus view);
 *  omit for the cross-project view (Command only).
 *  Ordered by focusedAt ascending (earliest-starred first). */
export function listFocusedWorkItems(projectId?: ULID): WorkItem[] {
  const conditions = [isNull(workItems.deletedAt), isNotNull(workItems.focusedAt)];
  if (projectId !== undefined) {
    conditions.push(eq(workItems.projectId, projectId));
  }
  const rows = getDb()
    .select()
    .from(workItems)
    .where(and(...conditions))
    .orderBy(asc(workItems.focusedAt))
    .all() as WorkItemRow[];
  return rows.map(toDomain);
}

/** Section 35 — look up a work item by its callsign (`pc-2`, `pc-2.1`, …)
 *  within a project. Returns null if no live row matches. Callsign is
 *  project-scoped + write-once + only assigned to non-agent rows; the
 *  partial unique index guarantees at most one match per project. */
export function getWorkItemByCallsign(projectId: ULID, callsign: string): WorkItem | null {
  const row = getDb()
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.callsign, callsign),
        isNull(workItems.deletedAt),
      ),
    )
    .get() as WorkItemRow | undefined;
  return row ? toDomain(row) : null;
}

/** Cross-project callsign lookup — resolves `pc-pty-chat-356` regardless of
 *  which project the caller is operating in. Since callsigns embed a
 *  project-specific prefix (e.g. `pc-pty-chat`), collisions across projects
 *  are extremely unlikely, but the function returns the first live match to
 *  handle the edge case gracefully. Used exclusively by the rich-link resolver
 *  (hover preview) which is a read-only, non-mutating path. */
export function getWorkItemByCallsignGlobal(callsign: string): WorkItem | null {
  const row = getDb()
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.callsign, callsign),
        isNull(workItems.deletedAt),
      ),
    )
    .get() as WorkItemRow | undefined;
  return row ? toDomain(row) : null;
}

/** Move a work item to a new stage, appending a 'move' history entry.
 *  Returns the updated WorkItem, or null if the id isn't found.
 *  Section 27 — `targetStatus` lets the caller pin the post-move status
 *  based on the destination stage's flags (is_done → 'complete',
 *  is_cancelled → 'cancelled'). Defaults to 'pending' for non-terminal moves,
 *  preserving on_enter workflow re-fire semantics. `noteOnHistory` carries
 *  an optional free-form line (cancellation reason etc.) onto the move entry. */
export function moveWorkItemStage(
  id: ULID,
  toStage: string,
  targetStatus: WorkItemStatus = 'pending',
  noteOnHistory: string | null = null,
): WorkItem | null {
  const row = getRowById(id);
  if (!row) return null;
  const from = row.stageId;
  const entry: WorkItemHistoryEntry = {
    ts: new Date().toISOString(),
    kind: 'move',
    from,
    to: toStage,
    ...(noteOnHistory ? { note: noteOnHistory } : {}),
  };
  const position = nextPosition(row.projectId, toStage, row.parentId);
  const updated: WorkItemRow = {
    ...row,
    stageId: toStage,
    status: targetStatus,
    statusReason: null,
    history: [...row.history, entry],
    position,
    version: row.version + 1,
    updatedAt: Date.now(),
  };
  getDb().update(workItems).set(updated).where(eq(workItems.id, id)).run();
  return toDomain(updated);
}

/** Merge field updates and append an 'update' history entry.
 *
 *  `body` and `title` are real columns on the work item — when the caller
 *  passes them through this fields-merge endpoint (the path agents take when
 *  they call `pc_update_work_item` to write their report), promote them onto
 *  their columns rather than burying them in the `fields` JSON blob. Pre-F#3
 *  behaviour was to stuff them under `fields.body` / `fields.title`, leaving
 *  `wi.body` frozen as the original task descriptor. That silently broke
 *  workflow `$node.output` refs (which read `wi.body`) and `body_contains` AC
 *  predicates (which also read `wi.body`). The history entry still records the
 *  caller's exact payload so audit trails stay intact. */
export function updateWorkItemFields(id: ULID, fields: Record<string, unknown>): WorkItem | null {
  const row = getRowById(id);
  if (!row) return null;

  // Split off column-shaped string body/title; non-string payloads (or empty
  // titles) flow through into the fields blob unchanged so callers that
  // legitimately store custom keys called "body"/"title" don't lose data.
  const mergedFields: Record<string, unknown> = { ...row.fields };
  let bodyColumn: string | null = null;
  let titleColumn: string | null = null;
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'body' && typeof value === 'string') {
      bodyColumn = value;
      continue;
    }
    if (key === 'title' && typeof value === 'string' && value.trim() !== '') {
      titleColumn = value;
      continue;
    }
    mergedFields[key] = value;
  }

  const entry: WorkItemHistoryEntry = {
    ts: new Date().toISOString(),
    kind: 'update',
    fields,
  };
  const updated: WorkItemRow = {
    ...row,
    ...(bodyColumn !== null ? { body: bodyColumn } : {}),
    ...(titleColumn !== null ? { title: titleColumn } : {}),
    fields: mergedFields,
    history: [...row.history, entry],
    version: row.version + 1,
    updatedAt: Date.now(),
  };
  getDb().update(workItems).set(updated).where(eq(workItems.id, id)).run();
  return toDomain(updated);
}

/** Update status + statusReason. Used by the workflow runtime's lock + unlock hooks. */
export function updateWorkItemStatus(
  id: ULID,
  status: WorkItemStatus,
  statusReason: string | null = null,
): WorkItem | null {
  const row = getRowById(id);
  if (!row) return null;
  const updated: WorkItemRow = {
    ...row,
    status,
    statusReason,
    version: row.version + 1,
    updatedAt: Date.now(),
  };
  getDb().update(workItems).set(updated).where(eq(workItems.id, id)).run();
  return toDomain(updated);
}

export interface PatchWorkItemInput {
  /** Optimistic-concurrency check. Mismatch throws WorkItemVersionConflictError. */
  expectedVersion: number;
  title?: string;
  body?: string;
  stageId?: string;
  parentId?: ULID | null;
  position?: number;
  type?: WorkItemType;
  /** Replaces the fields map wholesale. Callers wanting merge semantics
   *  should read first + spread. (validateFields is run at the service layer.) */
  fields?: Record<string, unknown>;
  /** Slice 010 — set/clear the Area bucket FK. Omit to leave unchanged;
   *  pass null to move the item to Uncaptured. */
  areaId?: ULID | null;
}

/** Version-checked patch. Used by the WorkItemService for non-workflow mutations
 *  (UI edits via the detail modal). Returns the updated WorkItem; throws
 *  WorkItemVersionConflictError on version mismatch; returns null if the id
 *  isn't found or is soft-deleted. */
export function patchWorkItem(id: ULID, input: PatchWorkItemInput): WorkItem | null {
  const row = getRowById(id);
  if (!row) return null;
  if (row.version !== input.expectedVersion) {
    throw new WorkItemVersionConflictError(id, input.expectedVersion, row.version, toDomain(row));
  }
  const updated: WorkItemRow = {
    ...row,
    title: input.title ?? row.title,
    body: input.body ?? row.body,
    stageId: input.stageId ?? row.stageId,
    parentId: input.parentId === undefined ? row.parentId : input.parentId,
    position: input.position ?? row.position,
    type: input.type ?? row.type,
    fields: input.fields ?? row.fields,
    areaId: input.areaId === undefined ? row.areaId : input.areaId,
    version: row.version + 1,
    updatedAt: Date.now(),
  };
  getDb().update(workItems).set(updated).where(eq(workItems.id, id)).run();
  return toDomain(updated);
}

/** Soft-delete: set deletedAt + status='archived'. listWorkItems / getWorkItem
 *  filter on `deletedAt IS NULL`, so the row stops appearing. Use
 *  `getWorkItemIncludingArchived` / `listArchivedWorkItems` to see them. */
export function softDeleteWorkItem(id: ULID): WorkItem | null {
  const row = getRowById(id);
  if (!row) return null;
  const now = Date.now();
  const updated: WorkItemRow = {
    ...row,
    status: 'archived',
    statusReason: null,
    version: row.version + 1,
    updatedAt: now,
    deletedAt: now,
  };
  getDb().update(workItems).set(updated).where(eq(workItems.id, id)).run();
  return toDomain(updated);
}

/** Restore a soft-deleted item. Resets status to 'pending' and clears deletedAt.
 *  Returns null if the id isn't found OR isn't currently archived. */
export function restoreWorkItem(id: ULID): WorkItem | null {
  const row = getDb()
    .select()
    .from(workItems)
    .where(and(eq(workItems.id, id), isNotNull(workItems.deletedAt)))
    .get() as WorkItemRow | undefined;
  if (!row) return null;
  const updated: WorkItemRow = {
    ...row,
    status: 'pending',
    statusReason: null,
    version: row.version + 1,
    updatedAt: Date.now(),
    deletedAt: null,
  };
  getDb().update(workItems).set(updated).where(eq(workItems.id, id)).run();
  return toDomain(updated);
}

/** Read a work item including soft-deleted rows. Used by restore + activity views. */
export function getWorkItemIncludingArchived(id: ULID): WorkItem | null {
  const row = getDb()
    .select()
    .from(workItems)
    .where(eq(workItems.id, id))
    .get() as WorkItemRow | undefined;
  return row ? toDomain(row) : null;
}

/** List archived items for a project. Used by the "Show archived" toggle. */
export function listArchivedWorkItems(projectId: ULID): WorkItem[] {
  const rows = getDb()
    .select()
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), isNotNull(workItems.deletedAt)))
    .orderBy(asc(workItems.position), asc(workItems.createdAt))
    .all() as WorkItemRow[];
  return rows.map(toDomain);
}

/** Count items in a given stage (for stage-delete orphan check). */
export function countWorkItemsInStage(projectId: ULID, stageId: string): number {
  const items = getDb()
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.stageId, stageId),
        isNull(workItems.deletedAt),
      ),
    )
    .all();
  return items.length;
}

/** Bulk-move items from one stage to another. Used when a stage is deleted
 *  with the `force` + `fallbackStageId` flags. Items keep their position
 *  order within the new stage, but positions are renumbered to slot in
 *  after any existing items in the fallback. */
export function reassignStage(
  projectId: ULID,
  fromStage: string,
  toStage: string,
): number {
  const rows = getDb()
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.stageId, fromStage),
        isNull(workItems.deletedAt),
      ),
    )
    .orderBy(asc(workItems.position), asc(workItems.createdAt))
    .all() as WorkItemRow[];
  if (rows.length === 0) return 0;
  let basePosition = nextPosition(projectId, toStage, null);
  const now = Date.now();
  for (const row of rows) {
    const updated: WorkItemRow = {
      ...row,
      stageId: toStage,
      position: basePosition,
      version: row.version + 1,
      updatedAt: now,
    };
    getDb().update(workItems).set(updated).where(eq(workItems.id, row.id)).run();
    basePosition += 1;
  }
  return rows.length;
}

/** Section 16b.7 — append a single history entry without touching any other
 *  column (so we don't disturb the `version` optimistic-concurrency
 *  counter; agent-comms audit rows are informational, not user edits). The
 *  agent-comms HTTP routes call this via `recordAgentAudit` after the
 *  primary effect of the tool call lands. Returns the updated WorkItem,
 *  or null if the id isn't found / is soft-deleted (audit is best-effort;
 *  callers swallow the null). */
export function appendWorkItemHistory(
  id: ULID,
  entry: WorkItemHistoryEntry,
): WorkItem | null {
  const row = getRowById(id);
  if (!row) return null;
  const updated: WorkItemRow = {
    ...row,
    history: [...row.history, entry],
    updatedAt: Date.now(),
  };
  getDb().update(workItems).set(updated).where(eq(workItems.id, id)).run();
  return toDomain(updated);
}

/** Section 26.5 — list non-archived children of a parent work item. Used by
 *  the tier-1 verification path to populate `child_work_items_done`. Stays
 *  archive-aware (soft-deleted children don't count) to match the other
 *  reads in this repo. */
export function listChildWorkItems(parentId: ULID): WorkItem[] {
  const rows = getDb()
    .select()
    .from(workItems)
    .where(and(eq(workItems.parentId, parentId), isNull(workItems.deletedAt)))
    .orderBy(asc(workItems.position), asc(workItems.createdAt))
    .all() as WorkItemRow[];
  return rows.map(toDomain);
}

/** Replace the entire done-checklist for a work item.
 *  Bumps `version` and appends an 'update' history entry.
 *  Returns the updated WorkItem, or null if the id isn't found / is soft-deleted. */
export function setDoneChecklist(id: ULID, items: DoneChecklistItem[]): WorkItem | null {
  const row = getRowById(id);
  if (!row) return null;
  const entry: WorkItemHistoryEntry = {
    ts: new Date().toISOString(),
    kind: 'update',
    note: `done-checklist set (${items.length} items)`,
  };
  const updated: WorkItemRow = {
    ...row,
    doneChecklist: items,
    history: [...row.history, entry],
    version: row.version + 1,
    updatedAt: Date.now(),
  };
  getDb().update(workItems).set(updated).where(eq(workItems.id, id)).run();
  return toDomain(updated);
}

/** Flip one item's `done` flag in the done-checklist.
 *
 *  TARGETED read-modify-write: only `done_checklist`, `history`, `version`, and
 *  `updated_at` are written — `fields` and all other columns are untouched.
 *  This is the fix for Risk #1 (concurrent `patchWorkItem` + tick losing data).
 *
 *  Returns the updated WorkItem, or null if the work item isn't found or is
 *  soft-deleted, or if `itemId` doesn't match any checklist item (clean no-op). */
export function tickDoneChecklistItem(
  id: ULID,
  itemId: string,
  done: boolean,
): WorkItem | null {
  const row = getRowById(id);
  if (!row) return null;
  const checklist = row.doneChecklist ?? [];
  const idx = checklist.findIndex((item) => item.id === itemId);
  if (idx === -1) return null; // item not found — caller handles as clean no-op
  const newChecklist: DoneChecklistItem[] = checklist.map((item, i) =>
    i === idx ? { ...item, done } : item,
  );
  const entry: WorkItemHistoryEntry = {
    ts: new Date().toISOString(),
    kind: 'update',
    note: `done-checklist "${checklist[idx].label}" → ${done ? 'done' : 'open'}`,
  };
  const newHistory = [...row.history, entry];
  const newVersion = row.version + 1;
  const now = Date.now();
  // Targeted write — only the checklist-related columns; fields/body/title untouched.
  getDb()
    .update(workItems)
    .set({ doneChecklist: newChecklist, history: newHistory, version: newVersion, updatedAt: now })
    .where(eq(workItems.id, id))
    .run();
  return toDomain({ ...row, doneChecklist: newChecklist, history: newHistory, version: newVersion, updatedAt: now });
}

/**
 * Apply a workflow-run outcome atomically: set status + statusReason and append
 * a history note in one update. The runtime calls this from the unlock hook so
 * the UI never observes a "new status, stale history" intermediate state.
 */
export function applyRunOutcome(
  id: ULID,
  status: WorkItemStatus,
  statusReason: string | null,
  historyNote: string,
): WorkItem | null {
  const row = getRowById(id);
  if (!row) return null;
  const entry: WorkItemHistoryEntry = {
    ts: new Date().toISOString(),
    kind: 'update',
    note: historyNote,
  };
  const updated: WorkItemRow = {
    ...row,
    status,
    statusReason,
    history: [...row.history, entry],
    version: row.version + 1,
    updatedAt: Date.now(),
  };
  getDb().update(workItems).set(updated).where(eq(workItems.id, id)).run();
  return toDomain(updated);
}
