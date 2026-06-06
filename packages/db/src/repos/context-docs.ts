// Slice 1 (Areas + context model) — ContextDoc repo.
//
// Persistence only (no outbox writes — deferred to Slice 2 when the UI needs
// live updates). Mirrors repos/areas.ts: DbExecutor-injectable `*InDb`
// variants + getDb() wrappers.
//
// Scope-pointer invariant (belt-and-suspenders alongside the SQL CHECK):
// exactly one of (projectId, areaId, workItemId) may be non-null. The writer
// throws before touching the DB when the constraint is violated.
//
// FTS5 search lives here too (Step 4). All FTS queries use getRawDb() because
// Drizzle cannot model virtual tables.

import { and, asc, eq, isNull } from 'drizzle-orm';
import type { ULID } from '@pc/domain';
import { getDb, getRawDb } from '../connection.ts';
import type { DbExecutor } from '../connection.ts';
import { newId } from '../id.ts';
import { contextDocs, workItems } from '../schema.ts';

// ── Row types ────────────────────────────────────────────────────────────────

export interface ContextDocRow {
  id: ULID;
  projectId: ULID | null;
  areaId: ULID | null;
  workItemId: ULID | null;
  title: string;
  body: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** One-scope constraint — exactly one field must be set. */
export type ContextDocScope =
  | { projectId: ULID; areaId?: undefined; workItemId?: undefined }
  | { areaId: ULID; projectId?: undefined; workItemId?: undefined }
  | { workItemId: ULID; projectId?: undefined; areaId?: undefined };

export interface CreateContextDocInput {
  scope: ContextDocScope;
  title: string;
  body?: string;
  author?: string;
}

export interface UpdateContextDocInput {
  title?: string;
  body?: string;
}

/** A doc tagged with its scope distance rank (0 = leaf, higher = farther away).
 *  Used by the chain builder to determine inline priority. */
export interface ContextDocWithRank extends ContextDocRow {
  /** 0 = leaf work-item, 1 = parent, ... N-1 = area, N = project. */
  distanceRank: number;
  scopeKind: 'project' | 'area' | 'work-item';
}

/** Result row from a context-doc FTS search. */
export interface ContextDocSearchResult {
  id: ULID;
  title: string;
  /** Short excerpt from the FTS `snippet()` function. */
  snippet: string;
  scopeKind: 'project' | 'area' | 'work-item';
  projectId: ULID | null;
  areaId: ULID | null;
  workItemId: ULID | null;
  author: string;
  updatedAt: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function enforceScope(scope: ContextDocScope): void {
  const set = [scope.projectId, scope.areaId, scope.workItemId].filter(Boolean).length;
  if (set !== 1) {
    throw new Error(
      `ContextDoc scope must have exactly one non-null pointer; got ${set}`,
    );
  }
}

function scopeToColumns(scope: ContextDocScope): {
  projectId: ULID | null;
  areaId: ULID | null;
  workItemId: ULID | null;
} {
  return {
    projectId: scope.projectId ?? null,
    areaId: scope.areaId ?? null,
    workItemId: scope.workItemId ?? null,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function createContextDoc(input: CreateContextDocInput): ContextDocRow {
  return createContextDocInDb(getDb(), input);
}

export function createContextDocInDb(
  db: DbExecutor,
  input: CreateContextDocInput,
): ContextDocRow {
  enforceScope(input.scope);
  const now = Date.now();
  const row: ContextDocRow = {
    id: newId(),
    ...scopeToColumns(input.scope),
    title: input.title,
    body: input.body ?? '',
    author: input.author ?? 'user',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  db.insert(contextDocs).values(row).run();
  return row;
}

export function updateContextDoc(
  id: ULID,
  input: UpdateContextDocInput,
): ContextDocRow | null {
  return updateContextDocInDb(getDb(), id, input);
}

export function updateContextDocInDb(
  db: DbExecutor,
  id: ULID,
  input: UpdateContextDocInput,
): ContextDocRow | null {
  const existing = getContextDocInDb(db, id);
  if (!existing || existing.deletedAt !== null) return null;
  if (input.title === undefined && input.body === undefined) return existing;
  const now = Date.now();
  const patch: Partial<ContextDocRow> & { updatedAt: number } = { updatedAt: now };
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = input.body;
  db.update(contextDocs).set(patch).where(eq(contextDocs.id, id)).run();
  return getContextDocInDb(db, id);
}

export function getContextDoc(id: ULID): ContextDocRow | null {
  return getContextDocInDb(getDb(), id);
}

export function getContextDocInDb(db: DbExecutor, id: ULID): ContextDocRow | null {
  const row = db
    .select()
    .from(contextDocs)
    .where(and(eq(contextDocs.id, id), isNull(contextDocs.deletedAt)))
    .get() as ContextDocRow | undefined;
  return row ?? null;
}

export function softDeleteContextDoc(id: ULID): ContextDocRow | null {
  return softDeleteContextDocInDb(getDb(), id);
}

export function softDeleteContextDocInDb(
  db: DbExecutor,
  id: ULID,
): ContextDocRow | null {
  const existing = getContextDocInDb(db, id);
  if (!existing) return null;
  const now = Date.now();
  db.update(contextDocs)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(contextDocs.id, id))
    .run();
  return db
    .select()
    .from(contextDocs)
    .where(eq(contextDocs.id, id))
    .get() as ContextDocRow | null ?? null;
}

// ── Scope list (direct) ───────────────────────────────────────────────────────

export interface ListContextDocsOptions {
  scope: ContextDocScope;
}

/** List docs directly attached to exactly one scope (no chain walk). */
export function listContextDocsForScope(opts: ListContextDocsOptions): ContextDocRow[] {
  return listContextDocsForScopeInDb(getDb(), opts);
}

export function listContextDocsForScopeInDb(
  db: DbExecutor,
  opts: ListContextDocsOptions,
): ContextDocRow[] {
  enforceScope(opts.scope);
  const { projectId, areaId, workItemId } = scopeToColumns(opts.scope);
  let whereClause;
  if (projectId) {
    whereClause = and(eq(contextDocs.projectId, projectId), isNull(contextDocs.deletedAt));
  } else if (areaId) {
    whereClause = and(eq(contextDocs.areaId, areaId), isNull(contextDocs.deletedAt));
  } else {
    whereClause = and(eq(contextDocs.workItemId, workItemId!), isNull(contextDocs.deletedAt));
  }
  return db
    .select()
    .from(contextDocs)
    .where(whereClause)
    .orderBy(asc(contextDocs.createdAt))
    .all() as ContextDocRow[];
}

// ── Chain read (project → area → ancestor WIs → leaf WI) ─────────────────────

export interface ListContextChainDocsInput {
  /** The leaf work item. The chain walks up from here. */
  workItemId: ULID;
  /** Project id — used to fetch project-scoped docs. */
  projectId: ULID;
}

/**
 * Walk the full context chain for a work item:
 *   project docs → area docs (via work_items.area_id) → ancestor WI docs
 *   (walk parentId up) → leaf WI docs.
 *
 * Returns docs tagged with distanceRank (0 = leaf, higher = farther away) so
 * the budget enforcer knows which to inline first.
 */
export function listContextChainDocs(
  input: ListContextChainDocsInput,
): ContextDocWithRank[] {
  return listContextChainDocsInDb(getDb(), input);
}

export function listContextChainDocsInDb(
  db: DbExecutor,
  input: ListContextChainDocsInput,
): ContextDocWithRank[] {
  const { workItemId, projectId } = input;
  const results: ContextDocWithRank[] = [];

  // 1. Walk the ancestor chain collecting (wiId, distanceRank) in leaf-first
  //    order; also capture the first areaId encountered (from the leaf).
  const wiChain: ULID[] = [];
  let areaIdFound: ULID | null = null;
  let cur: ULID | null = workItemId;
  const seen = new Set<ULID>();

  while (cur && !seen.has(cur)) {
    seen.add(cur);
    wiChain.push(cur);
    const row = db
      .select({ parentId: workItems.parentId, areaId: workItems.areaId })
      .from(workItems)
      .where(eq(workItems.id, cur))
      .get() as { parentId: ULID | null; areaId: ULID | null } | undefined;
    if (!row) break;
    if (!areaIdFound && row.areaId) areaIdFound = row.areaId;
    cur = row.parentId ?? null;
  }

  // 2. Leaf WI docs (distance 0) → ancestor docs (distance 1, 2, ...).
  wiChain.forEach((wiId, idx) => {
    const docs = listContextDocsForScopeInDb(db, { scope: { workItemId: wiId } });
    for (const doc of docs) {
      results.push({ ...doc, distanceRank: idx, scopeKind: 'work-item' });
    }
  });

  // Ranks for area + project sit above the deepest WI ancestor.
  const wiCount = wiChain.length;
  const areaRank = wiCount;
  const projectRank = wiCount + 1;

  // 3. Area docs (one rank higher than deepest ancestor).
  if (areaIdFound) {
    const areaDocs = listContextDocsForScopeInDb(db, { scope: { areaId: areaIdFound } });
    for (const doc of areaDocs) {
      results.push({ ...doc, distanceRank: areaRank, scopeKind: 'area' });
    }
  }

  // 4. Project docs (highest rank = farthest).
  const projectDocs = listContextDocsForScopeInDb(db, { scope: { projectId } });
  for (const doc of projectDocs) {
    results.push({ ...doc, distanceRank: projectRank, scopeKind: 'project' });
  }

  // Sort by distanceRank ascending (leaf first), then createdAt within rank.
  results.sort((a, b) => a.distanceRank - b.distanceRank || a.createdAt - b.createdAt);
  return results;
}

// ── FTS5 search ───────────────────────────────────────────────────────────────

export interface SearchContextDocsInput {
  projectId: ULID;
  query: string;
  /** Narrow to a specific area. */
  areaId?: ULID;
  /** Narrow to a specific scope kind. */
  scopeKind?: 'project' | 'area' | 'work-item';
  /** Narrow to docs updated after this Unix ms timestamp. */
  updatedAfter?: number;
}

/**
 * FTS5 full-text search across context_docs in a project.
 * Uses getRawDb() — Drizzle cannot query virtual tables.
 * The query string is quoted (each bare word becomes a phrase) to prevent FTS5
 * syntax errors from user/agent-supplied strings.
 */
export function searchContextDocs(
  input: SearchContextDocsInput,
): ContextDocSearchResult[] {
  const raw = getRawDb();

  // Guard: FTS5 must be available.
  const fts5Available = (raw.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS v").get() as { v: number }).v;
  if (!fts5Available) throw new Error('FTS5 is not available in this SQLite build');

  // Sanitize query: wrap each whitespace-separated token in double quotes to
  // form a valid FTS5 MATCH expression. Empty query → return empty.
  const sanitized = sanitizeFts5Query(input.query);
  if (!sanitized) return [];

  // Build the SQL with optional filters.
  const conditions: string[] = [
    'cd.deleted_at IS NULL',
    // Scope to the project: a doc belongs to this project if it has project_id
    // = projectId, or its area_id links to an area in the project, or its
    // work_item_id links to a work item in the project.
    `(cd.project_id = ? OR cd.area_id IN (SELECT id FROM areas WHERE project_id = ? AND deleted_at IS NULL) OR cd.work_item_id IN (SELECT id FROM work_items WHERE project_id = ? AND deleted_at IS NULL))`,
  ];
  const params: unknown[] = [input.projectId, input.projectId, input.projectId];

  if (input.areaId) {
    conditions.push('cd.area_id = ?');
    params.push(input.areaId);
  }
  if (input.scopeKind === 'project') {
    conditions.push('cd.project_id IS NOT NULL');
  } else if (input.scopeKind === 'area') {
    conditions.push('cd.area_id IS NOT NULL');
  } else if (input.scopeKind === 'work-item') {
    conditions.push('cd.work_item_id IS NOT NULL');
  }
  if (input.updatedAfter !== undefined) {
    conditions.push('cd.updated_at > ?');
    params.push(input.updatedAfter);
  }

  const whereClause = conditions.join(' AND ');
  const sql = `
    SELECT cd.id, cd.title, cd.project_id, cd.area_id, cd.work_item_id, cd.author, cd.updated_at,
           snippet(context_docs_fts, 1, '<b>', '</b>', '…', 16) AS snippet
    FROM context_docs_fts
    JOIN context_docs cd ON context_docs_fts.rowid = cd.rowid
    WHERE context_docs_fts MATCH ?
      AND ${whereClause}
    ORDER BY rank
    LIMIT 50
  `;

  const rows = raw.prepare(sql).all([sanitized, ...params]) as Array<{
    id: string;
    title: string;
    project_id: string | null;
    area_id: string | null;
    work_item_id: string | null;
    author: string;
    updated_at: number;
    snippet: string;
  }>;

  return rows.map((r) => ({
    id: r.id as ULID,
    title: r.title,
    snippet: r.snippet ?? '',
    scopeKind: r.project_id ? 'project' : r.area_id ? 'area' : 'work-item',
    projectId: (r.project_id as ULID) ?? null,
    areaId: (r.area_id as ULID) ?? null,
    workItemId: (r.work_item_id as ULID) ?? null,
    author: r.author,
    updatedAt: r.updated_at,
  }));
}

/**
 * Sanitize a user/agent query string into a safe FTS5 MATCH expression.
 * Each whitespace-separated token is double-quoted (phrase match) so
 * bare colons, parentheses, OR/AND operators, etc. don't cause parse errors.
 * Returns an empty string if the input has no usable tokens.
 */
export function sanitizeFts5Query(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '')) // strip embedded quotes
    .filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}
