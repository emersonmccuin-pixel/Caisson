// WorkItemService — project-scoped facade for work-item mutations.
//
// Owns create / patch / move / softDelete / restore / list / get. Integrates
// validateFields on create + patch, asserts stageId exists on the project's
// stage list before touching the DB, version-checks PATCH + move via the repo's
// WorkItemVersionConflictError.
//
// Does NOT fire workflows. The workflow-runtime keeps its on_enter trigger
// flow; new UI routes that want both (version check + workflow firing) compose
// service.move(...) + workflow-runtime atop. workflow-runtime.createWorkItem
// becomes a shim that delegates here (per the 2b spec — single place that does
// stage + field validation).
//
// FD-12 (M2): every mutation goes through the ONE write door —
// WorkItemMutationGateway.commitWorkItemChange runs the repo write AND the
// durable `work-item.changed` live_outbox row in the SAME transaction (the
// old save-then-announce two-step left a crash window where a change landed
// with no receipt). The live-relay fans the canonical frame post-commit. The
// version stamp is the work item's existing `version` counter — the frontend
// discards stale or duplicate deliveries where incoming version ≤ stored.

import type {
  FieldSchema,
  Project,
  ULID,
  ValidateFieldsErrors,
  WorkItem,
  WorkItemStatus,
  WorkItemType,
} from '@pc/domain';
import { postMoveStatusForStage, validateFields } from '@pc/domain';
import {
  createWorkItem as dbCreateWorkItem,
  getWorkItem as dbGetWorkItem,
  getWorkItemByCallsign as dbGetWorkItemByCallsign,
  getWorkItemIncludingArchived,
  listArchivedWorkItems,
  listWorkItems as dbListWorkItems,
  moveWorkItemStage,
  patchWorkItem as dbPatchWorkItem,
  restoreWorkItem as dbRestoreWorkItem,
  softDeleteWorkItem as dbSoftDeleteWorkItem,
  WorkItemVersionConflictError,
} from '@pc/db';
import type { WorkItemAreaFilter } from '@pc/db';
import { WorkItemMutationGateway } from '@pc/app-services';

/** Crockford base-32 ULID — 26 chars, no I/L/O/U. Case-insensitive.
 *  Used to discriminate a ULID reference from a callsign in the modal
 *  opener route. Exported for routes that need the same discriminant
 *  (e.g. the includeArchived ULID branch). */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function looksLikeUlid(ref: string): boolean {
  return ULID_RE.test(ref);
}

/** Section 35 — resolve a work-item reference that may be either a ULID
 *  (canonical id) or a callsign (`pc-2`, `pc-2.1`). Used by the modal-
 *  opener route + MCP tools so the orchestrator can hand the user a
 *  human-readable handle without the system having to remember which
 *  shape it's looking at. Returns null if no live row matches. */
export function resolveWorkItemRef(projectId: ULID, ref: string): WorkItem | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (ULID_RE.test(trimmed)) {
    const wi = dbGetWorkItem(trimmed as ULID);
    // Project-scope guard: a ULID lookup that hits a different project
    // returns null so the route reports 404 instead of leaking the row.
    if (wi && wi.projectId !== projectId) return null;
    return wi;
  }
  return dbGetWorkItemByCallsign(projectId, trimmed);
}

export interface WorkItemServiceOptions {
  projectId: ULID;
  /** Resolves the current Project (used for stage assertion). Callable each
   *  time so stage edits in the same process take effect immediately. */
  getProject: () => Project;
  /** Resolves the current per-project field schemas. Called fresh on each
   *  create/patch so a schema edit lands without service restart. */
  getFieldSchemas: () => FieldSchema[];
}

export interface CreateWorkItemServiceInput {
  stageId: string;
  title: string;
  body?: string;
  parentId?: ULID | null;
  position?: number;
  type?: WorkItemType;
  fields?: Record<string, unknown>;
  /** Section 19 — mark a v2 workflow run root. */
  isWorkflowRoot?: boolean;
  /** Slice 010 — Area bucket FK at create time. */
  areaId?: ULID | null;
}

export interface PatchWorkItemServiceInput {
  expectedVersion: number;
  title?: string;
  body?: string;
  stageId?: string;
  parentId?: ULID | null;
  position?: number;
  type?: WorkItemType;
  fields?: Record<string, unknown>;
  /** Slice 010 — set/clear the Area bucket FK (null = Uncaptured). */
  areaId?: ULID | null;
}

export interface MoveWorkItemServiceInput {
  expectedVersion: number;
  stageId: string;
  position?: number;
}

export interface ListWorkItemsServiceOptions {
  stage?: string;
  parentId?: ULID | null;
  /** Default false. When true, returns archived rows in place of live ones. */
  includeArchived?: boolean;
  /** Opaque continuation token from a previous response's `nextCursor`. The
   *  server encodes the last row's (position, createdAt, id) tuple so the
   *  next page resumes correctly under the repo's (position ASC, createdAt
   *  ASC) ordering. Section 22.5 — previously this was a bare ULID compared
   *  with `id > cursor`, which skipped or duplicated rows whenever the id
   *  order disagreed with the position/createdAt order (i.e. anytime a row
   *  had been drag-reordered). */
  cursor?: string;
  /** Hard cap of 500 per the buildout. Default 200. */
  limit?: number;
  // pc-pty-chat-254 — new structured filters.
  /** Narrow to an Area, or to Uncaptured (null / 'uncaptured'). */
  areaId?: WorkItemAreaFilter;
  /** Filter by exact status. */
  status?: WorkItemStatus;
  /** When true, exclude complete/cancelled/archived items.
   *  NOTE: `type` filter deferred — see pc-pty-chat-285. */
  open?: boolean;
}

export interface ListWorkItemsServiceResult {
  items: WorkItem[];
  nextCursor: string | null;
}

/** Cursor payload — the row key tuple the repo's ORDER BY uses. Encoded as
 *  base64-JSON so the wire shape is opaque to the client. Versioned via the
 *  `v` field so future order-key changes don't silently misinterpret old
 *  cursors held by a long-running tab. */
interface WorkItemCursor {
  v: 1;
  position: number;
  createdAt: number;
  id: string;
}

function encodeCursor(c: WorkItemCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): WorkItemCursor | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<WorkItemCursor>;
    if (
      parsed.v !== 1 ||
      typeof parsed.position !== 'number' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.id !== 'string'
    ) {
      return null;
    }
    return {
      v: 1,
      position: parsed.position,
      createdAt: parsed.createdAt,
      id: parsed.id,
    };
  } catch {
    return null;
  }
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/** Service-level validation failure. Maps to HTTP 400 with the `errors` map. */
export class FieldValidationError extends Error {
  constructor(public readonly errors: Record<string, string>) {
    super(`field validation failed: ${Object.keys(errors).join(', ')}`);
    this.name = 'FieldValidationError';
  }
}

/** Service-level stage assertion failure. Maps to HTTP 400. */
export class UnknownStageError extends Error {
  constructor(public readonly stageId: string) {
    super(`unknown stage: ${stageId}`);
    this.name = 'UnknownStageError';
  }
}

export class WorkItemService {
  /** FD-12 — the one write door: repo write + outbox receipt in one txn. */
  private readonly gateway = new WorkItemMutationGateway();

  constructor(private readonly opts: WorkItemServiceOptions) {}

  list(opts: ListWorkItemsServiceOptions = {}): ListWorkItemsServiceResult {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const all = opts.includeArchived
      ? listArchivedWorkItems(this.opts.projectId)
      : dbListWorkItems(this.opts.projectId, {
          // DB-side filters (pc-pty-chat-254). `includeArchived` bypasses these
          // (listArchivedWorkItems has no filter support yet).
          ...(opts.areaId !== undefined ? { areaId: opts.areaId } : {}),
          ...(opts.status !== undefined ? { status: opts.status } : {}),
          ...(opts.open === true ? { open: true } : {}),
        });

    const filtered = all.filter((wi) => {
      if (opts.stage !== undefined && wi.stageId !== opts.stage) return false;
      if (opts.parentId !== undefined) {
        const wanted = opts.parentId;
        if ((wi.parentId ?? null) !== (wanted ?? null)) return false;
      }
      // JS-side fallback for includeArchived path (DB call doesn't support new filters).
      if (opts.includeArchived) {
        if (opts.areaId !== undefined) {
          const want = opts.areaId;
          const isUncaptured = want === null || want === 'uncaptured';
          if (isUncaptured ? wi.areaId !== null : wi.areaId !== want) return false;
        }
        if (opts.status !== undefined && wi.status !== opts.status) return false;
        if (opts.open === true &&
            (wi.status === 'complete' || wi.status === 'cancelled' || wi.status === 'archived')) {
          return false;
        }
      }
      return true;
    });

    // Section 22.5 — cursor encodes (position, createdAt, id). Tuple-style
    // strict-greater-than picks up exactly where the previous page left off
    // under the repo's (position ASC, createdAt ASC) ordering. An unparseable
    // cursor is treated as "start from the beginning" — same behaviour as a
    // missing cursor.
    const cursorTuple = opts.cursor ? decodeCursor(opts.cursor) : null;
    const sliced = cursorTuple
      ? filtered.filter((wi) => {
          if (wi.position !== cursorTuple.position) return wi.position > cursorTuple.position;
          if (wi.createdAt !== cursorTuple.createdAt) {
            return wi.createdAt > cursorTuple.createdAt;
          }
          return wi.id > cursorTuple.id;
        })
      : filtered;
    const page = sliced.slice(0, limit);
    const nextCursor =
      sliced.length > limit
        ? encodeCursor({
            v: 1,
            position: page[page.length - 1]!.position,
            createdAt: page[page.length - 1]!.createdAt,
            id: page[page.length - 1]!.id,
          })
        : null;
    return { items: page, nextCursor };
  }

  get(id: ULID, opts: { includeArchived?: boolean } = {}): WorkItem | null {
    return opts.includeArchived ? getWorkItemIncludingArchived(id) : dbGetWorkItem(id);
  }

  create(input: CreateWorkItemServiceInput): WorkItem {
    const title = input.title.trim();
    if (!title) throw new Error('title required');
    this.assertStage(input.stageId);

    const validated = validateFields(input.fields ?? {}, this.opts.getFieldSchemas(), {
      mode: 'create',
    });
    if (!validated.ok) {
      throw new FieldValidationError((validated as ValidateFieldsErrors).errors);
    }

    let workItem!: WorkItem;
    this.gateway.commitWorkItemChange({
      projectId: this.opts.projectId,
      reason: 'created',
      mutate: () => {
        workItem = dbCreateWorkItem({
          projectId: this.opts.projectId,
          title,
          stageId: input.stageId,
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          fields: validated.value,
          ...(input.isWorkflowRoot !== undefined ? { isWorkflowRoot: input.isWorkflowRoot } : {}),
          ...(input.areaId !== undefined ? { areaId: input.areaId } : {}),
        });
        return workItem;
      },
    });
    return workItem;
  }

  /** Version-checked patch. Re-validates fields against current schemas in
   *  patch mode (only the keys supplied are checked + coerced). Throws
   *  WorkItemVersionConflictError on version mismatch; the route handler
   *  maps that to HTTP 409 + the current row. */
  patch(id: ULID, input: PatchWorkItemServiceInput): WorkItem {
    if (input.stageId !== undefined) this.assertStage(input.stageId);

    let fields: Record<string, unknown> | undefined;
    if (input.fields !== undefined) {
      const current = dbGetWorkItem(id);
      const merged = { ...(current?.fields ?? {}), ...input.fields };
      const validated = validateFields(merged, this.opts.getFieldSchemas(), { mode: 'patch' });
      if (!validated.ok) {
        throw new FieldValidationError((validated as ValidateFieldsErrors).errors);
      }
      fields = validated.value;
    }

    let patched!: WorkItem;
    this.gateway.commitWorkItemChange({
      projectId: this.opts.projectId,
      reason: 'patched',
      mutate: () => {
        const row = dbPatchWorkItem(id, {
          expectedVersion: input.expectedVersion,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(fields !== undefined ? { fields } : {}),
          ...(input.areaId !== undefined ? { areaId: input.areaId } : {}),
        });
        if (!row) throw new Error(`unknown work item: ${id}`);
        patched = row;
        return row;
      },
    });
    return patched;
  }

  /** Version-checked stage move + optional explicit position. Does NOT fire
   *  workflows — composed paths (workflow-runtime.moveWorkItem) wrap this
   *  with worktree-ensure + trigger logic on top.
   *  Section 27 — `noteOnHistory` carries an optional free-form line onto
   *  the move entry (cancellation reason etc.). */
  move(id: ULID, input: MoveWorkItemServiceInput, noteOnHistory?: string): WorkItem {
    this.assertStage(input.stageId);
    // Use the version-checked patch path; the repo's moveWorkItemStage doesn't
    // do version checks (workflow path owns those externally), so we route
    // version-checked UI moves through patch + the repo auto-bumps position
    // on stage change when position isn't supplied.
    const current = dbGetWorkItem(id);
    if (!current) throw new Error(`unknown work item: ${id}`);
    if (current.version !== input.expectedVersion) {
      throw new WorkItemVersionConflictError(id, input.expectedVersion, current.version, current);
    }
    // If only position is changing (same stage), use patch with the new position.
    // If stage is changing, delegate to moveWorkItemStage so history gets a
    // 'move' entry, then optionally re-patch the position. Both writes land in
    // the ONE gateway transaction with the receipt (FD-12).
    let result!: WorkItem;
    this.gateway.commitWorkItemChange({
      projectId: this.opts.projectId,
      reason: 'moved',
      mutate: () => {
        if (current.stageId === input.stageId) {
          const patched = dbPatchWorkItem(id, {
            expectedVersion: input.expectedVersion,
            ...(input.position !== undefined ? { position: input.position } : {}),
          });
          if (!patched) throw new Error(`unknown work item: ${id}`);
          result = patched;
        } else {
          // Section 27 — compute the target status from the destination stage's
          // flags. is_done → 'complete', is_cancelled → 'cancelled', else 'pending'.
          const destStage = this.opts.getProject().stages.find((s) => s.id === input.stageId)!;
          const targetStatus = postMoveStatusForStage(destStage);
          const moved = moveWorkItemStage(id, input.stageId, targetStatus, noteOnHistory ?? null);
          if (!moved) throw new Error(`unknown work item: ${id}`);
          if (input.position !== undefined) {
            const patched = dbPatchWorkItem(id, {
              expectedVersion: moved.version,
              position: input.position,
            });
            if (!patched) throw new Error(`unknown work item: ${id}`);
            result = patched;
          } else {
            result = moved;
          }
        }
        return result;
      },
    });
    return result;
  }

  softDelete(id: ULID): WorkItem {
    let deleted!: WorkItem;
    this.gateway.commitWorkItemChange({
      projectId: this.opts.projectId,
      reason: 'soft-deleted',
      mutate: () => {
        const row = dbSoftDeleteWorkItem(id);
        if (!row) throw new Error(`unknown work item: ${id}`);
        deleted = row;
        return row;
      },
    });
    return deleted;
  }

  restore(id: ULID): WorkItem {
    let restored!: WorkItem;
    this.gateway.commitWorkItemChange({
      projectId: this.opts.projectId,
      reason: 'restored',
      mutate: () => {
        const row = dbRestoreWorkItem(id);
        if (!row) throw new Error(`unknown work item: ${id} (or not archived)`);
        restored = row;
        return row;
      },
    });
    return restored;
  }

  private assertStage(stageId: string): void {
    const project = this.opts.getProject();
    if (!project.stages.find((s) => s.id === stageId)) {
      throw new UnknownStageError(stageId);
    }
  }
}

export { WorkItemVersionConflictError };
