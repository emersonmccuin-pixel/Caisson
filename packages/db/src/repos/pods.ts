// Section 17a.2 + 17a.4 — Repository layer for the pod tables.
//
// Two surfaces:
//   1. CRUD per table (agents + the three content tables). Each accepts an
//      input shape with sensible defaults; soft-delete + restore on agents,
//      hard-delete on content rows.
//   2. `getPodForSpawn(name, projectId?)` — returns the merged row bundle the
//      materialiser (17a.3) consumes. v1 = global-only; 17c upgrades the merge.
//
// All queries are live-only (`deleted_at IS NULL` for agents). Pod content
// tables don't soft-delete — they're owned by the agent and disappear when
// the user prunes a knowledge doc / secret / server.
//
// 17a.4 — Audit-on-mutate. Every mutator accepts a required `audit:
// AuditInput` arg and writes an `agent_audit` row in the SAME transaction as
// the mutation. Secrets log event-only (NULL value columns). Restore is
// intentionally NOT audited — agent state already reflects the un-delete; see
// pod-audit.ts header for the carve-out.
//
// updateAgent multi-field semantics: one audit row per changed field, all
// sharing a `changeSetId`. If the caller didn't supply one and >1 field
// changed, a fresh ULID is minted to group them. No audit emitted when the
// patch has no field changes.

import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type {
  AgentEffort,
  AgentModel,
  PodAgentRow,
  PodAuditField,
  PodKnowledgeKind,
  PodKnowledgeRow,
  PodOrigin,
  PodScope,
  PodSecretRow,
  PodSpawnBundle,
  ULID,
} from '@pc/domain';
import { mergeRequiredAgentTools } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { agentAudit, agentKnowledge, agentSecrets, agents } from '../schema.ts';
import { type AuditInput, buildAuditRow } from './pod-audit.ts';

// --- agents -----------------------------------------------------------------

export interface CreateAgentInput {
  /** Optional pre-minted ULID — useful when an upstream flow needs to reference
   *  the new id before insert (e.g. materialising children in the same tx). */
  id?: ULID;
  name: string;
  scope: PodScope;
  /** Required when `scope === 'project'`; ignored otherwise. */
  projectId?: ULID | null;
  prompt?: string;
  tools?: string[];
  model?: AgentModel | null;
  effort?: AgentEffort | null;
  maxTurns?: number | null;
  description?: string;
  /** Section 36 — defaults to `'user-created'`. Only the boot-time stock-pod
   *  seed passes `'stock'`. */
  origin?: PodOrigin;
  /** Section 36 — orchestrator-facing dispatch hint, rendered into the
   *  orchestrator's `{{AVAILABLE_AGENTS}}` variable. Optional. */
  dispatchGuidance?: string | null;
}

function rowToAgent(row: typeof agents.$inferSelect): PodAgentRow {
  return {
    id: row.id as ULID,
    name: row.name,
    scope: row.scope,
    projectId: row.projectId ?? null,
    prompt: row.prompt,
    tools: row.tools,
    model: row.model ?? null,
    effort: row.effort ?? null,
    maxTurns: row.maxTurns ?? null,
    description: row.description,
    origin: row.origin,
    dispatchGuidance: row.dispatchGuidance ?? null,
    expectedOutput: row.expectedOutput ?? null,
    rev: row.rev ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

/** Compact snapshot of the agent's authored content — what `created` and
 *  `deleted` audit rows carry as their value column. Excludes id/timestamps
 *  (redundant against the agent_audit FK + created_at). */
function agentSnapshot(row: PodAgentRow): string {
  return JSON.stringify({
    name: row.name,
    scope: row.scope,
    projectId: row.projectId,
    prompt: row.prompt,
    tools: row.tools,
    model: row.model,
    effort: row.effort,
    maxTurns: row.maxTurns,
    description: row.description,
    origin: row.origin,
    dispatchGuidance: row.dispatchGuidance,
  });
}

export function createAgent(input: CreateAgentInput, audit: AuditInput): PodAgentRow {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('createAgent: projectId is required when scope === "project"');
  }
  const now = Date.now();
  const id = (input.id ?? newId()) as ULID;
  const row = {
    id,
    name: input.name,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId ?? null : null,
    prompt: input.prompt ?? '',
    // Section 26 — every agent always has the work-item contract tools, no
    // matter what the caller passed. Idempotent merge dedupes if the caller
    // already listed them.
    tools: mergeRequiredAgentTools(input.tools ?? []),
    model: input.model ?? null,
    effort: input.effort ?? null,
    maxTurns: input.maxTurns ?? null,
    description: input.description ?? '',
    origin: input.origin ?? 'user-created',
    dispatchGuidance: input.dispatchGuidance ?? null,
    rev: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const out = rowToAgent(row as typeof agents.$inferSelect);
  const auditValues = buildAuditRow(
    {
      agentId: id,
      field: 'created',
      newValue: agentSnapshot(out),
      audit,
    },
    now,
  );
  getDb().transaction((tx) => {
    tx.insert(agents).values(row).run();
    tx.insert(agentAudit).values(auditValues).run();
  });
  return out;
}

export function getAgentById(id: ULID): PodAgentRow | null {
  const row = getDb()
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), isNull(agents.deletedAt)))
    .get();
  return row ? rowToAgent(row) : null;
}

export interface GetAgentByNameInput {
  name: string;
  scope: PodScope;
  /** Required when `scope === 'project'`. */
  projectId?: ULID | null;
}

export function getAgentByName(input: GetAgentByNameInput): PodAgentRow | null {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('getAgentByName: projectId is required when scope === "project"');
  }
  const projectCmp =
    input.scope === 'project'
      ? eq(agents.projectId, input.projectId!)
      : isNull(agents.projectId);
  const row = getDb()
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.name, input.name),
        eq(agents.scope, input.scope),
        projectCmp,
        isNull(agents.deletedAt),
      ),
    )
    .get();
  return row ? rowToAgent(row) : null;
}

export interface ListAgentsOptions {
  scope?: PodScope;
  /** When set, narrows to project-scope rows for this project. Implies
   *  `scope: 'project'` unless `includeGlobals` is also set. */
  projectId?: ULID;
  /** When true alongside `projectId`, returns BOTH project-scope rows for
   *  the project AND all global-scope rows — the union the Agents tab
   *  surfaces to the user. */
  includeGlobals?: boolean;
}

export function listAgents(opts: ListAgentsOptions = {}): PodAgentRow[] {
  const conditions = [isNull(agents.deletedAt)];
  if (opts.projectId !== undefined) {
    if (opts.includeGlobals) {
      // scope='global' OR (scope='project' AND projectId=opts.projectId)
      conditions.push(
        or(
          eq(agents.scope, 'global'),
          and(eq(agents.scope, 'project'), eq(agents.projectId, opts.projectId)),
        )!,
      );
    } else {
      conditions.push(eq(agents.scope, 'project'));
      conditions.push(eq(agents.projectId, opts.projectId));
    }
  } else if (opts.scope !== undefined) {
    conditions.push(eq(agents.scope, opts.scope));
  }
  const rows = getDb()
    .select()
    .from(agents)
    .where(and(...conditions))
    .orderBy(asc(agents.name))
    .all();
  return rows.map(rowToAgent);
}

export interface UpdateAgentInput {
  name?: string;
  prompt?: string;
  tools?: string[];
  model?: AgentModel | null;
  effort?: AgentEffort | null;
  maxTurns?: number | null;
  description?: string;
  /** Section 36 — patchable so future UI can edit it; `origin` is NOT
   *  patchable (set once at creation). */
  dispatchGuidance?: string | null;
}

/** Map UpdateAgentInput keys to (PodAuditField, db-column-name) pairs. Order
 *  matters: audit rows are emitted in this order for deterministic test output. */
const UPDATE_AGENT_FIELD_MAP: ReadonlyArray<
  [keyof UpdateAgentInput, PodAuditField, keyof typeof agents.$inferSelect]
> = [
  ['name', 'name', 'name'],
  ['prompt', 'prompt', 'prompt'],
  ['tools', 'tools', 'tools'],
  ['model', 'model', 'model'],
  ['effort', 'effort', 'effort'],
  ['maxTurns', 'max_turns', 'maxTurns'],
  ['description', 'description', 'description'],
  ['dispatchGuidance', 'dispatch_guidance', 'dispatchGuidance'],
];

export function updateAgent(
  id: ULID,
  patch: UpdateAgentInput,
  audit: AuditInput,
): PodAgentRow | null {
  const existing = getAgentById(id);
  if (!existing) return null;

  // Section 26 — every agent always has the work-item contract tools, no
  // matter what the caller passed. If `tools` is being updated, merge the
  // required tools back in so they survive removal attempts (UI checkbox,
  // hand-edited row, etc.).
  const effectivePatch: UpdateAgentInput =
    patch.tools !== undefined
      ? { ...patch, tools: mergeRequiredAgentTools(patch.tools) }
      : patch;

  // Identify the fields that ACTUALLY change (patch provides + value differs
  // from existing). We don't emit audit rows for no-op updates.
  type Change = { auditField: PodAuditField; column: string; prior: string; next: string };
  const changes: Change[] = [];
  for (const [patchKey, auditField, column] of UPDATE_AGENT_FIELD_MAP) {
    const nextRaw = effectivePatch[patchKey];
    if (nextRaw === undefined) continue;
    const priorRaw = existing[patchKey as keyof PodAgentRow];
    if (JSON.stringify(nextRaw) === JSON.stringify(priorRaw)) continue;
    changes.push({
      auditField,
      column,
      prior: JSON.stringify(priorRaw),
      next: JSON.stringify(nextRaw),
    });
  }
  if (changes.length === 0) return existing; // pure no-op; skip the UPDATE entirely

  const now = Date.now();
  const set: Record<string, unknown> = { updatedAt: now, rev: (existing.rev ?? 0) + 1 };
  for (const [patchKey, , column] of UPDATE_AGENT_FIELD_MAP) {
    if (effectivePatch[patchKey] !== undefined) set[column] = effectivePatch[patchKey];
  }
  // Multi-field edits group under a shared change_set_id. Solo edits use the
  // caller-supplied id (null = ungrouped).
  const groupedAudit: AuditInput =
    changes.length > 1 && !audit.changeSetId
      ? { ...audit, changeSetId: newId() as ULID }
      : audit;
  const auditRows = changes.map((c) =>
    buildAuditRow(
      {
        agentId: id,
        field: c.auditField,
        priorValue: c.prior,
        newValue: c.next,
        audit: groupedAudit,
      },
      now,
    ),
  );
  getDb().transaction((tx) => {
    tx.update(agents).set(set).where(eq(agents.id, id)).run();
    for (const r of auditRows) tx.insert(agentAudit).values(r).run();
  });
  return getAgentById(id);
}

/** Flip `deleted_at`. Idempotent — returns the (now-deleted) row if it
 *  existed live, or null if no such id was live to begin with. Audited as
 *  `field='deleted'` with prior_value = pre-delete agent snapshot. */
export function softDeleteAgent(id: ULID, audit: AuditInput): PodAgentRow | null {
  const existing = getAgentById(id);
  if (!existing) return null;
  const now = Date.now();
  const out = { ...existing, deletedAt: now, updatedAt: now, rev: (existing.rev ?? 0) + 1 };
  const auditValues = buildAuditRow(
    {
      agentId: id,
      field: 'deleted',
      priorValue: agentSnapshot(existing),
      audit,
    },
    now,
  );
  getDb().transaction((tx) => {
    tx.update(agents).set({ deletedAt: now, updatedAt: now, rev: out.rev }).where(eq(agents.id, id)).run();
    tx.insert(agentAudit).values(auditValues).run();
  });
  return out;
}

/** Clear `deleted_at`. Returns the restored row, or null if no such id (or
 *  not currently deleted). Intentionally NOT audited in v1 — agent state
 *  reflects the un-delete; the original `'deleted'` audit row is the
 *  canonical revert path. See pod-audit.ts header. */
export function restoreAgent(id: ULID): PodAgentRow | null {
  const row = getDb().select().from(agents).where(eq(agents.id, id)).get();
  if (!row || row.deletedAt === null) return null;
  const now = Date.now();
  const existing = rowToAgent(row);
  getDb().update(agents).set({ deletedAt: null, updatedAt: now, rev: (existing.rev ?? 0) + 1 }).where(eq(agents.id, id)).run();
  return getAgentById(id);
}

/** Promote a project-scoped agent to global scope. Flips `scope='global'`,
 *  clears `project_id`. Throws if the row is already global or doesn't
 *  exist. UNIQUE constraint on `agents_global_name_idx` may throw if a
 *  global with the same name already exists — caller surfaces as 409. */
export function promoteAgentToGlobal(id: ULID, audit: AuditInput): PodAgentRow | null {
  const existing = getAgentById(id);
  if (!existing) return null;
  if (existing.scope === 'global') {
    throw new Error('already global');
  }
  const now = Date.now();
  const prior = JSON.stringify({ scope: existing.scope, projectId: existing.projectId });
  const next = JSON.stringify({ scope: 'global', projectId: null });
  const auditRow = buildAuditRow(
    {
      agentId: id,
      field: 'scope',
      priorValue: prior,
      newValue: next,
      audit,
    },
    now,
  );
  getDb().transaction((tx) => {
    tx.update(agents)
      .set({ scope: 'global', projectId: null, updatedAt: now, rev: (existing.rev ?? 0) + 1 })
      .where(eq(agents.id, id))
      .run();
    tx.insert(agentAudit).values(auditRow).run();
  });
  return getAgentById(id);
}

export interface CloneAgentToProjectInput {
  /** Source agent. Any scope; typically global. */
  sourceId: ULID;
  /** Target project for the clone. */
  targetProjectId: ULID;
  /** Optional name override. Defaults to source name. */
  name?: string;
}

export interface CloneAgentResult {
  agent: PodAgentRow;
  /** Counts of content rows that were copied. */
  copied: { knowledge: number };
}

/** Clone a pod into a target project as a project-scope row. Copies the
 *  agent's scalar fields + every knowledge row + every mcp-server row.
 *  Secrets are NOT copied — they're sensitive and the cloning user may not
 *  intend to share them. The target project re-creates whatever secrets the
 *  pod actually needs.
 *
 *  Throws 'already exists' if the target project already has a live
 *  project-scope row with the resolved name. UNIQUE constraint on
 *  `agents_project_name_idx` is the structural guard; we pre-check for a
 *  cleaner error message. */
export function cloneAgentToProject(
  input: CloneAgentToProjectInput,
  audit: AuditInput,
): CloneAgentResult {
  const source = getAgentById(input.sourceId);
  if (!source) throw new Error(`unknown source pod: ${input.sourceId}`);
  const name = (input.name ?? source.name).trim();
  if (!name) throw new Error('clone name cannot be empty');

  const collision = getAgentByName({
    name,
    scope: 'project',
    projectId: input.targetProjectId,
  });
  if (collision) {
    throw new Error(
      `a project pod named "${name}" already exists in this project`,
    );
  }

  const sourceKnowledge =
    source.scope === 'project' && source.projectId
      ? listKnowledge({ agentId: source.id, projectId: source.projectId })
      : listKnowledge({ agentId: source.id, scope: 'global' });

  const now = Date.now();
  const newAgentId = newId() as ULID;
  const agentRow = {
    id: newAgentId,
    name,
    scope: 'project' as PodScope,
    projectId: input.targetProjectId,
    prompt: source.prompt,
    tools: source.tools,
    model: source.model,
    effort: source.effort,
    maxTurns: source.maxTurns,
    description: source.description,
    // Cloned pods are user-created regardless of the source's origin —
    // the new row is the user's own copy in this project.
    origin: 'user-created' as PodOrigin,
    dispatchGuidance: source.dispatchGuidance,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const newAgent = rowToAgent(agentRow as typeof agents.$inferSelect);

  const cloneAudit: AuditInput = {
    ...audit,
    reason: audit.reason ?? `cloned-from-${source.id}`,
  };

  const knowledgeRows = sourceKnowledge.map((k) => ({
    insertRow: {
      id: newId() as ULID,
      agentId: newAgentId,
      scope: 'project' as PodScope,
      projectId: input.targetProjectId,
      name: k.name,
      kind: k.kind,
      content: k.content,
      createdAt: now,
      updatedAt: now,
    },
    auditField: 'knowledge' as PodAuditField,
    snapshot: knowledgeSnapshot({
      ...k,
      scope: 'project',
      projectId: input.targetProjectId,
    }),
  }));

  const agentAuditRow = buildAuditRow(
    {
      agentId: newAgentId,
      field: 'created',
      newValue: agentSnapshot(newAgent),
      audit: cloneAudit,
    },
    now,
  );

  getDb().transaction((tx) => {
    tx.insert(agents).values(agentRow).run();
    tx.insert(agentAudit).values(agentAuditRow).run();
    for (const k of knowledgeRows) {
      tx.insert(agentKnowledge).values(k.insertRow).run();
      tx.insert(agentAudit)
        .values(
          buildAuditRow(
            {
              agentId: newAgentId,
              field: k.auditField,
              fieldRef: k.insertRow.id,
              newValue: k.snapshot,
              audit: cloneAudit,
            },
            now,
          ),
        )
        .run();
    }
  });

  return {
    agent: newAgent,
    copied: { knowledge: knowledgeRows.length },
  };
}

/** Bump an agent's rev + updatedAt without changing any other fields. Called
 *  by nested-mutation paths (knowledge / secret / mcp-server changes) to
 *  ensure the next full-snapshot broadcast carries a strictly-monotonic rev. */
export function bumpAgentRev(id: ULID): void {
  const existing = getAgentById(id);
  if (!existing) return;
  const now = Date.now();
  getDb()
    .update(agents)
    .set({ rev: (existing.rev ?? 0) + 1, updatedAt: now })
    .where(eq(agents.id, id))
    .run();
}

// --- agent_knowledge --------------------------------------------------------

export interface CreateKnowledgeInput {
  id?: ULID;
  agentId: ULID;
  scope: PodScope;
  projectId?: ULID | null;
  name: string;
  kind?: PodKnowledgeKind;
  content?: string;
}

function rowToKnowledge(row: typeof agentKnowledge.$inferSelect): PodKnowledgeRow {
  return {
    id: row.id as ULID,
    agentId: row.agentId as ULID,
    scope: row.scope,
    projectId: row.projectId ?? null,
    name: row.name,
    kind: row.kind,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function knowledgeSnapshot(row: PodKnowledgeRow): string {
  return JSON.stringify({ name: row.name, kind: row.kind, content: row.content });
}

export function createKnowledge(
  input: CreateKnowledgeInput,
  audit: AuditInput,
): PodKnowledgeRow {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('createKnowledge: projectId is required when scope === "project"');
  }
  const now = Date.now();
  const id = (input.id ?? newId()) as ULID;
  const row = {
    id,
    agentId: input.agentId,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId ?? null : null,
    name: input.name,
    kind: input.kind ?? 'knowledge',
    content: input.content ?? '',
    createdAt: now,
    updatedAt: now,
  };
  const out = rowToKnowledge(row as typeof agentKnowledge.$inferSelect);
  const auditValues = buildAuditRow(
    {
      agentId: input.agentId,
      field: 'knowledge',
      fieldRef: id,
      newValue: knowledgeSnapshot(out),
      audit,
    },
    now,
  );
  getDb().transaction((tx) => {
    tx.insert(agentKnowledge).values(row).run();
    tx.insert(agentAudit).values(auditValues).run();
  });
  return out;
}

export function getKnowledge(id: ULID): PodKnowledgeRow | null {
  const row = getDb()
    .select()
    .from(agentKnowledge)
    .where(eq(agentKnowledge.id, id))
    .get();
  return row ? rowToKnowledge(row) : null;
}

export interface GetKnowledgeByNameInput {
  agentId: ULID;
  scope: PodScope;
  projectId?: ULID | null;
  name: string;
}

export function getKnowledgeByName(input: GetKnowledgeByNameInput): PodKnowledgeRow | null {
  const projectCmp =
    input.scope === 'project'
      ? eq(agentKnowledge.projectId, input.projectId!)
      : isNull(agentKnowledge.projectId);
  const row = getDb()
    .select()
    .from(agentKnowledge)
    .where(
      and(
        eq(agentKnowledge.agentId, input.agentId),
        eq(agentKnowledge.scope, input.scope),
        projectCmp,
        eq(agentKnowledge.name, input.name),
      ),
    )
    .get();
  return row ? rowToKnowledge(row) : null;
}

export interface ListKnowledgeOptions {
  agentId: ULID;
  scope?: PodScope;
  projectId?: ULID;
}

export function listKnowledge(opts: ListKnowledgeOptions): PodKnowledgeRow[] {
  const conditions = [eq(agentKnowledge.agentId, opts.agentId)];
  if (opts.projectId !== undefined) {
    conditions.push(eq(agentKnowledge.scope, 'project'));
    conditions.push(eq(agentKnowledge.projectId, opts.projectId));
  } else if (opts.scope !== undefined) {
    conditions.push(eq(agentKnowledge.scope, opts.scope));
  }
  const rows = getDb()
    .select()
    .from(agentKnowledge)
    .where(and(...conditions))
    .orderBy(asc(agentKnowledge.name))
    .all();
  return rows.map(rowToKnowledge);
}

export interface UpdateKnowledgeInput {
  name?: string;
  kind?: PodKnowledgeKind;
  content?: string;
}

export function updateKnowledge(
  id: ULID,
  patch: UpdateKnowledgeInput,
  audit: AuditInput,
): PodKnowledgeRow | null {
  const existing = getKnowledge(id);
  if (!existing) return null;
  const set: Record<string, unknown> = {};
  let changed = false;
  if (patch.name !== undefined && patch.name !== existing.name) {
    set.name = patch.name;
    changed = true;
  }
  if (patch.kind !== undefined && patch.kind !== existing.kind) {
    set.kind = patch.kind;
    changed = true;
  }
  if (patch.content !== undefined && patch.content !== existing.content) {
    set.content = patch.content;
    changed = true;
  }
  if (!changed) return existing;

  const now = Date.now();
  set.updatedAt = now;
  const next: PodKnowledgeRow = {
    ...existing,
    name: patch.name ?? existing.name,
    kind: patch.kind ?? existing.kind,
    content: patch.content ?? existing.content,
    updatedAt: now,
  };
  const auditValues = buildAuditRow(
    {
      agentId: existing.agentId,
      field: 'knowledge',
      fieldRef: id,
      priorValue: knowledgeSnapshot(existing),
      newValue: knowledgeSnapshot(next),
      audit,
    },
    now,
  );
  getDb().transaction((tx) => {
    tx.update(agentKnowledge).set(set).where(eq(agentKnowledge.id, id)).run();
    tx.insert(agentAudit).values(auditValues).run();
  });
  return getKnowledge(id);
}

export function deleteKnowledge(id: ULID, audit: AuditInput): boolean {
  const existing = getKnowledge(id);
  if (!existing) return false;
  const now = Date.now();
  const auditValues = buildAuditRow(
    {
      agentId: existing.agentId,
      field: 'knowledge',
      fieldRef: id,
      priorValue: knowledgeSnapshot(existing),
      audit,
    },
    now,
  );
  let changed = false;
  getDb().transaction((tx) => {
    const result = tx.delete(agentKnowledge).where(eq(agentKnowledge.id, id)).run();
    changed = (result.changes ?? 0) > 0;
    if (changed) tx.insert(agentAudit).values(auditValues).run();
  });
  return changed;
}

// --- agent_secrets ----------------------------------------------------------

export interface CreateSecretInput {
  id?: ULID;
  agentId: ULID;
  scope: PodScope;
  projectId?: ULID | null;
  envVarName: string;
  valuePlaintext: string;
}

function rowToSecret(row: typeof agentSecrets.$inferSelect): PodSecretRow {
  return {
    id: row.id as ULID,
    agentId: row.agentId as ULID,
    scope: row.scope,
    projectId: row.projectId ?? null,
    envVarName: row.envVarName,
    valuePlaintext: row.valuePlaintext,
    createdAt: row.createdAt,
  };
}

export function createSecret(input: CreateSecretInput, audit: AuditInput): PodSecretRow {
  if (input.scope === 'project' && !input.projectId) {
    throw new Error('createSecret: projectId is required when scope === "project"');
  }
  const now = Date.now();
  const id = (input.id ?? newId()) as ULID;
  const row = {
    id,
    agentId: input.agentId,
    scope: input.scope,
    projectId: input.scope === 'project' ? input.projectId ?? null : null,
    envVarName: input.envVarName,
    valuePlaintext: input.valuePlaintext,
    createdAt: now,
  };
  // Secrets: event-only audit — value columns stay NULL. fieldRef carries the
  // env-var name so the History tab can still render "user added X".
  const auditValues = buildAuditRow(
    { agentId: input.agentId, field: 'secret', fieldRef: input.envVarName, audit },
    now,
  );
  getDb().transaction((tx) => {
    tx.insert(agentSecrets).values(row).run();
    tx.insert(agentAudit).values(auditValues).run();
  });
  return rowToSecret(row as typeof agentSecrets.$inferSelect);
}

export function getSecret(id: ULID): PodSecretRow | null {
  const row = getDb().select().from(agentSecrets).where(eq(agentSecrets.id, id)).get();
  return row ? rowToSecret(row) : null;
}

export interface GetSecretByEnvInput {
  agentId: ULID;
  scope: PodScope;
  projectId?: ULID | null;
  envVarName: string;
}

export function getSecretByEnvVarName(input: GetSecretByEnvInput): PodSecretRow | null {
  const projectCmp =
    input.scope === 'project'
      ? eq(agentSecrets.projectId, input.projectId!)
      : isNull(agentSecrets.projectId);
  const row = getDb()
    .select()
    .from(agentSecrets)
    .where(
      and(
        eq(agentSecrets.agentId, input.agentId),
        eq(agentSecrets.scope, input.scope),
        projectCmp,
        eq(agentSecrets.envVarName, input.envVarName),
      ),
    )
    .get();
  return row ? rowToSecret(row) : null;
}

export interface ListSecretsOptions {
  agentId: ULID;
  scope?: PodScope;
  projectId?: ULID;
}

export function listSecrets(opts: ListSecretsOptions): PodSecretRow[] {
  const conditions = [eq(agentSecrets.agentId, opts.agentId)];
  if (opts.projectId !== undefined) {
    conditions.push(eq(agentSecrets.scope, 'project'));
    conditions.push(eq(agentSecrets.projectId, opts.projectId));
  } else if (opts.scope !== undefined) {
    conditions.push(eq(agentSecrets.scope, opts.scope));
  }
  const rows = getDb()
    .select()
    .from(agentSecrets)
    .where(and(...conditions))
    .orderBy(asc(agentSecrets.envVarName))
    .all();
  return rows.map(rowToSecret);
}

export function deleteSecret(id: ULID, audit: AuditInput): boolean {
  const existing = getSecret(id);
  if (!existing) return false;
  const now = Date.now();
  const auditValues = buildAuditRow(
    {
      agentId: existing.agentId,
      field: 'secret',
      fieldRef: existing.envVarName,
      audit,
    },
    now,
  );
  let changed = false;
  getDb().transaction((tx) => {
    const result = tx.delete(agentSecrets).where(eq(agentSecrets.id, id)).run();
    changed = (result.changes ?? 0) > 0;
    if (changed) tx.insert(agentAudit).values(auditValues).run();
  });
  return changed;
}

// --- pod bundle -------------------------------------------------------------

/** Resolve a pod for dispatch: prefer a project-scoped row for this project,
 *  fall back to a live global row with the same name. Returns null when
 *  neither exists.
 *
 *  Section 22.1 — the 2026-05-25 codebase review found this was the
 *  load-bearing place where project-scoped pods became invisible at spawn.
 *  Stabilization pass switched it from "global only" to "project wins". */
/** THE policy: which agents a project may see and dispatch — its own
 *  project-scope pods + built-in (stock) globals. A global USER-CREATED pod is
 *  excluded; the user must copy it into the project (Add agent / clone) to use
 *  it, so the orchestrator can never reach a custom global it wasn't given.
 *  Single source of truth shared by `listProjectVisibleAgents`,
 *  `resolveAgentForDispatch`, the `{{AVAILABLE_AGENTS}}` prompt var, and the
 *  Agents-tab list route. */
export function isProjectDispatchable(agent: PodAgentRow): boolean {
  return agent.scope === 'project' || agent.origin === 'stock';
}

/** The agents visible/usable inside a project: project-scope pods + stock
 *  globals (see `isProjectDispatchable`). With no `projectId`, returns stock
 *  globals only. Both the orchestrator's available-agents list and the
 *  project agents-list route call this — one path, one rule. */
export function listProjectVisibleAgents(projectId?: ULID | null): PodAgentRow[] {
  const rows = projectId
    ? listAgents({ projectId, includeGlobals: true })
    : listAgents({ scope: 'global' });
  return rows.filter(isProjectDispatchable);
}

export function resolveAgentForDispatch(
  name: string,
  projectId?: ULID | null,
): PodAgentRow | null {
  if (projectId) {
    const project = getAgentByName({ name, scope: 'project', projectId });
    if (project) return project;
  }
  const global = getAgentByName({ name, scope: 'global' });
  return global && isProjectDispatchable(global) ? global : null;
}

/** Read the full pod the materialiser (17a.3) needs to render `.md` +
 *  `mcp.json` + env vars at spawn time.
 *
 *  Resolution: project-scoped row for this project wins, then live global
 *  row. Content rows are read with the resolved agent's own scope — a
 *  project pod's bundle carries that project's knowledge / secrets / mcp
 *  rows; a global pod's bundle carries the global ones.
 *
 *  Returns null when neither a project nor a global row with `name` exists.
 */
export function getPodForSpawn(name: string, projectId?: ULID | null): PodSpawnBundle | null {
  const agent = resolveAgentForDispatch(name, projectId);
  if (!agent) return null;
  if (agent.scope === 'project' && agent.projectId) {
    return {
      agent,
      knowledge: listKnowledge({ agentId: agent.id, projectId: agent.projectId }),
      secrets: listSecrets({ agentId: agent.id, projectId: agent.projectId }),
    };
  }
  return {
    agent,
    knowledge: listKnowledge({ agentId: agent.id, scope: 'global' }),
    secrets: listSecrets({ agentId: agent.id, scope: 'global' }),
  };
}
