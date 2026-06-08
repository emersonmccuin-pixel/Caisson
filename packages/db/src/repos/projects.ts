import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Project, ProjectSettings, Stage, ULID } from '@pc/domain';
import { withProjectSettingsDefaults } from '@pc/domain';
import { getDb } from '../connection.ts';
import type { DbExecutor } from '../connection.ts';
import { newId } from '../id.ts';
import { projects } from '../schema.ts';

export interface CreateProjectInput {
  /** Pre-generated ULID. Optional — when omitted the repo mints a new one.
   *  Used by the create-project flow so the scaffold pass (which embeds the
   *  id into hooks + .mcp.json) and the DB row share an identity. */
  id?: ULID;
  slug: string;
  name: string;
  stages: Stage[];
  folderPath: string;
  gitRemote?: string | null;
  settings?: Record<string, unknown>;
  /** Explicit sort position. Omit for the normal "append at max+1" behaviour;
   *  pass a sentinel (e.g. a negative value) to pin a reserved row like the
   *  Command space above every user project. */
  position?: number;
}

interface ProjectRow {
  id: ULID;
  slug: string;
  name: string;
  settings: Record<string, unknown>;
  stages: Stage[];
  folderPath: string;
  gitRemote: string | null;
  callsignSeq: number;
  stagesRev: number;
  notes: string | null;
  focusedAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

function toDomain(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    stages: row.stages,
    folderPath: row.folderPath,
    gitRemote: row.gitRemote,
    settings: withProjectSettingsDefaults(row.settings as Partial<ProjectSettings>),
    callsignSeq: row.callsignSeq ?? 0,
    notes: row.notes ?? null,
    focusedAt: row.focusedAt ?? null,
  };
}

export interface ListProjectsOptions {
  /** Include soft-deleted rows. Off by default — P11's `?include_deleted=1`
   *  is the only caller that opts in. */
  includeDeleted?: boolean;
}

export function listProjects(opts: ListProjectsOptions = {}): Project[] {
  return listProjectsInDb(getDb(), opts);
}

export function listProjectsInDb(
  db: DbExecutor,
  opts: ListProjectsOptions = {},
): Project[] {
  // Order by `position` asc, breaking ties on `created_at` so two rows that
  // somehow share a position stay in a deterministic order.
  const q = db
    .select()
    .from(projects)
    .orderBy(asc(projects.position), asc(projects.createdAt));
  const rows = (opts.includeDeleted
    ? q.all()
    : q.where(isNull(projects.deletedAt)).all()) as ProjectRow[];
  return rows.map(toDomain);
}

export function getProjectById(id: ULID): Project | null {
  return getProjectByIdInDb(getDb(), id);
}

export function getProjectByIdInDb(db: DbExecutor, id: ULID): Project | null {
  const row = db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .get() as ProjectRow | undefined;
  return row ? toDomain(row) : null;
}

export function getProjectBySlug(slug: string): Project | null {
  return getProjectBySlugInDb(getDb(), slug);
}

export function getProjectBySlugInDb(db: DbExecutor, slug: string): Project | null {
  const row = db
    .select()
    .from(projects)
    .where(and(eq(projects.slug, slug), isNull(projects.deletedAt)))
    .get() as ProjectRow | undefined;
  return row ? toDomain(row) : null;
}

export function createProject(input: CreateProjectInput): Project {
  return createProjectInDb(getDb(), input);
}

export function createProjectInDb(db: DbExecutor, input: CreateProjectInput): Project {
  const now = Date.now();
  const id = input.id ?? newId();
  const gitRemote = input.gitRemote ?? null;
  // 5+.4 (D87) — new projects land at the bottom of the rail. Soft-deleted
  // rows still count toward `max(position)` so the position space stays gap-
  // free across the lifetime of a project (cheaper than re-compacting on
  // soft-delete).
  let position = input.position;
  if (position === undefined) {
    const maxPos = db
      .select({ v: sql<number | null>`max(${projects.position})` })
      .from(projects)
      .get() as { v: number | null } | undefined;
    position = (maxPos?.v ?? -1) + 1;
  }
  db
    .insert(projects)
    .values({
      id,
      slug: input.slug,
      name: input.name,
      stages: input.stages,
      folderPath: input.folderPath,
      gitRemote,
      settings: input.settings ?? {},
      position,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return {
    id,
    slug: input.slug,
    name: input.name,
    stages: input.stages,
    folderPath: input.folderPath,
    gitRemote,
    settings: withProjectSettingsDefaults(input.settings as Partial<ProjectSettings> | undefined),
    callsignSeq: 0,
    notes: null,
    focusedAt: null,
  };
}

/** 5+.4 (D87) — drag-reorder. Rewrites the `position` column for the given
 *  IDs in order (0..N-1). Wrapped in a transaction so a partial failure can't
 *  leave the rail in a torn state. Unknown IDs are silently skipped — the API
 *  layer is the right place to enforce membership; this repo is just persist. */
export function reorderProjects(orderedIds: ULID[]): void {
  if (orderedIds.length === 0) return;
  const db = getDb();
  db.transaction((tx) => {
    reorderProjectsInDb(tx, orderedIds);
  });
}

export function reorderProjectsInDb(db: DbExecutor, orderedIds: ULID[]): void {
  if (orderedIds.length === 0) return;
  // Sanity-clamp against the existing membership so a stale list can't
  // promote a deleted row's position.
  const live = (db
    .select({ id: projects.id })
    .from(projects)
    .where(and(isNull(projects.deletedAt), inArray(projects.id, orderedIds)))
    .all() as { id: ULID }[]).map((r) => r.id);
  const liveSet = new Set(live);
  const finalOrder = orderedIds.filter((id) => liveSet.has(id));
  const now = Date.now();
  finalOrder.forEach((id, idx) => {
    db.update(projects)
      .set({ position: idx, updatedAt: now })
      .where(eq(projects.id, id))
      .run();
  });
}

/** Update the stored stages for a project. Atomically increments `stagesRev`
 *  and stamps each stage with the new rev so WS deltas carry a monotonic
 *  version the frontend can use to discard stale/duplicate envelopes. */
export function updateProjectStages(id: ULID, stages: Stage[]): Stage[] {
  const existing = getDb()
    .select({ stagesRev: projects.stagesRev })
    .from(projects)
    .where(eq(projects.id, id))
    .get() as { stagesRev: number } | undefined;
  const newRev = (existing?.stagesRev ?? 0) + 1;
  const stamped = stages.map((s) => ({ ...s, rev: newRev }));
  getDb()
    .update(projects)
    .set({ stages: stamped, stagesRev: newRev, updatedAt: Date.now() })
    .where(eq(projects.id, id))
    .run();
  return stamped;
}

/** Soft-delete a project: flip `deleted_at`. Idempotent — returns the row
 *  whether or not it was already deleted. Returns null if no such project.
 *  Filesystem is not touched (per the soft-delete contract). */
export function softDeleteProject(id: ULID): Project | null {
  return softDeleteProjectInDb(getDb(), id);
}

export function softDeleteProjectInDb(db: DbExecutor, id: ULID): Project | null {
  const existing = db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .get() as ProjectRow | undefined;
  if (!existing) return null;
  if (existing.deletedAt === null) {
    const now = Date.now();
    db
      .update(projects)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(projects.id, id))
      .run();
  }
  return toDomain({ ...existing, deletedAt: existing.deletedAt ?? Date.now() });
}

export interface UpdateProjectMetaInput {
  /** Display name. Slug stays locked — rename → slug migration is deferred. */
  name?: string;
  /** Origin URL; pass `null` to clear. Omit to leave unchanged. */
  gitRemote?: string | null;
  /** Partial overlay merged into the project's settings JSON. Omitted keys
   *  stay unchanged. */
  settings?: Partial<ProjectSettings>;
}

/** Patch the mutable metadata for a project (name + git remote). Returns
 *  the updated Project, or null if no such project (or soft-deleted). */
export function updateProjectMeta(id: ULID, input: UpdateProjectMetaInput): Project | null {
  return updateProjectMetaInDb(getDb(), id, input);
}

/** Save the scratch notes for a project. Returns the updated Project, or null
 *  if no such project (or soft-deleted). `text` is stored as-is; pass an
 *  empty string to clear (stored as '', not NULL). */
export function updateProjectNotes(id: ULID, text: string): Project | null {
  return updateProjectNotesInDb(getDb(), id, text);
}

/** Command focus — star/unstar a project. `focused` true stamps `focused_at`
 *  with now; false clears it. Returns the updated Project, or null if no such
 *  (live) project. */
export function setProjectFocus(id: ULID, focused: boolean): Project | null {
  return setProjectFocusInDb(getDb(), id, focused);
}

export function setProjectFocusInDb(db: DbExecutor, id: ULID, focused: boolean): Project | null {
  const existing = getProjectByIdInDb(db, id);
  if (!existing) return null;
  const now = Date.now();
  db
    .update(projects)
    .set({ focusedAt: focused ? now : null, updatedAt: now })
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .run();
  return getProjectByIdInDb(db, id);
}

export function updateProjectNotesInDb(db: DbExecutor, id: ULID, text: string): Project | null {
  const existing = db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .get() as ProjectRow | undefined;
  if (!existing) return null;
  db
    .update(projects)
    .set({ notes: text, updatedAt: Date.now() })
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .run();
  return toDomain({ ...existing, notes: text, updatedAt: Date.now() });
}

export function updateProjectMetaInDb(
  db: DbExecutor,
  id: ULID,
  input: UpdateProjectMetaInput,
): Project | null {
  const patch: {
    name?: string;
    gitRemote?: string | null;
    settings?: Record<string, unknown>;
    updatedAt: number;
  } = {
    updatedAt: Date.now(),
  };
  if (typeof input.name === 'string') patch.name = input.name;
  if (input.gitRemote !== undefined) patch.gitRemote = input.gitRemote;
  if (input.settings !== undefined) {
    const existing = getProjectByIdInDb(db, id);
    if (!existing) return null;
    patch.settings = { ...existing.settings, ...input.settings };
  }
  if (patch.name === undefined && patch.gitRemote === undefined && patch.settings === undefined) {
    return getProjectByIdInDb(db, id);
  }
  db
    .update(projects)
    .set(patch)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .run();
  return getProjectByIdInDb(db, id);
}
