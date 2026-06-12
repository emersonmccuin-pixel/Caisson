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

import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type {
  AgentContextDoc,
  AgentEffort,
  AgentModel,
  PodAgentRow,
  PodAuditField,
  PodOrigin,
  PodScope,
  PodSecretRow,
  PodSpawnBundle,
  ULID,
} from '@pc/domain';
import { mergeRequiredAgentTools } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { agentAudit, agentProjects, agentSecrets, agents } from '../schema.ts';
import { type ContextDocRow, listContextDocsForScope } from './context-docs.ts';
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
  /** pc-pty-chat-408 — place this agent in the shared library on creation.
   *  Defaults to false. */
  shareable?: boolean;
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
    shareable: row.shareable ?? false,
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
    shareable: row.shareable,
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
  const homeProjectId = input.scope === 'project' ? (input.projectId ?? null) : null;
  const row = {
    id,
    name: input.name,
    scope: input.scope,
    projectId: homeProjectId,
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
    shareable: input.shareable ?? false,
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
    // Membership — project-scoped agents get a membership row so they are
    // immediately visible via listProjectVisibleAgents.
    if (homeProjectId) {
      tx.insert(agentProjects)
        .values({ agentId: id, projectId: homeProjectId, createdAt: now })
        .onConflictDoNothing()
        .run();
    }
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

/** Flip the `shareable` flag on an agent. Does NOT touch membership rows or
 *  `projectId` — promoting keeps the original home-project attachment intact.
 *  Returns the updated row, or null if the agent doesn't exist. No-ops and
 *  returns the existing row when the flag is already at the requested value. */
export function setAgentShareable(id: ULID, shareable: boolean, audit: AuditInput): PodAgentRow | null {
  const existing = getAgentById(id);
  if (!existing) return null;
  if (existing.shareable === shareable) return existing; // no-op
  const now = Date.now();
  const auditRow = buildAuditRow(
    {
      agentId: id,
      field: 'shareable',
      priorValue: JSON.stringify(existing.shareable),
      newValue: JSON.stringify(shareable),
      audit,
    },
    now,
  );
  getDb().transaction((tx) => {
    tx.update(agents)
      .set({ shareable, updatedAt: now, rev: (existing.rev ?? 0) + 1 })
      .where(eq(agents.id, id))
      .run();
    tx.insert(agentAudit).values(auditRow).run();
  });
  return getAgentById(id);
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

// --- agent_projects (membership) --------------------------------------------

/** Attach an agent to a project. Idempotent — a duplicate insert is silently
 *  ignored (composite PK on (agentId, projectId) is the structural guard).
 *  Writes a `member-added` audit row each call even on no-op so history stays
 *  observable. */
export function addAgentToProject(agentId: ULID, projectId: ULID, audit: AuditInput): void {
  const now = Date.now();
  const auditRow = buildAuditRow(
    { agentId, field: 'member-added', fieldRef: projectId, audit },
    now,
  );
  getDb().transaction((tx) => {
    tx.insert(agentProjects)
      .values({ agentId, projectId, createdAt: now })
      .onConflictDoNothing()
      .run();
    tx.insert(agentAudit).values(auditRow).run();
  });
}

/** Detach an agent from a project. Allowed even if it is the last membership
 *  row — the agent stays in the library as a shareable orphan. No-ops
 *  silently if the membership row doesn't exist. Writes a `member-removed`
 *  audit row only when a row was actually deleted. */
export function removeAgentFromProject(agentId: ULID, projectId: ULID, audit: AuditInput): void {
  const now = Date.now();
  let removed = false;
  getDb().transaction((tx) => {
    const result = tx
      .delete(agentProjects)
      .where(and(eq(agentProjects.agentId, agentId), eq(agentProjects.projectId, projectId)))
      .run();
    removed = (result.changes ?? 0) > 0;
    if (removed) {
      tx.insert(agentAudit)
        .values(buildAuditRow({ agentId, field: 'member-removed', fieldRef: projectId, audit }, now))
        .run();
    }
  });
}

/** Return the project IDs this agent is currently attached to. */
export function listAgentProjects(agentId: ULID): ULID[] {
  return getDb()
    .select({ projectId: agentProjects.projectId })
    .from(agentProjects)
    .where(eq(agentProjects.agentId, agentId))
    .all()
    .map((r) => r.projectId as ULID);
}

/** Return the live (non-deleted) agents joined to a project via agent_projects. */
export function listProjectMemberAgents(projectId: ULID): PodAgentRow[] {
  const memberIds = getDb()
    .select({ agentId: agentProjects.agentId })
    .from(agentProjects)
    .where(eq(agentProjects.projectId, projectId))
    .all()
    .map((r) => r.agentId);
  if (memberIds.length === 0) return [];
  return getDb()
    .select()
    .from(agents)
    .where(and(inArray(agents.id, memberIds), isNull(agents.deletedAt)))
    .orderBy(asc(agents.name))
    .all()
    .map(rowToAgent);
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

/** THE visibility rule: the agents a project may see and dispatch.
 *
 *  - `origin='stock'` agents are implicitly all-projects (no membership rows,
 *    always included).
 *  - All other agents must have a row in `agent_projects` for this project to
 *    be visible here.
 *  - With no `projectId`, returns stock agents only (no project context).
 *
 *  Single source of truth shared by `resolveAgentForDispatch`, the
 *  `{{AVAILABLE_AGENTS}}` prompt var, and the Agents-tab list route.
 *  The old scope-based `isProjectDispatchable` predicate is replaced by this
 *  membership-aware query. */
export function listProjectVisibleAgents(projectId?: ULID | null): PodAgentRow[] {
  // Stock agents are always visible in every project (no membership rows needed).
  const stockAgents = getDb()
    .select()
    .from(agents)
    .where(and(eq(agents.origin, 'stock'), isNull(agents.deletedAt)))
    .orderBy(asc(agents.name))
    .all()
    .map(rowToAgent);

  if (!projectId) return stockAgents;

  // Member agents: those joined to this project via agent_projects.
  const memberAgents = listProjectMemberAgents(projectId);

  // Merge stock + members, deduplicating by id (stock rows are never in
  // agent_projects in practice, but guard for correctness).
  const seen = new Set<ULID>();
  const merged: PodAgentRow[] = [];
  for (const a of [...stockAgents, ...memberAgents]) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      merged.push(a);
    }
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve an agent for dispatch by name within the project's visible set
 *  (stock ∪ members).
 *
 *  Collision precedence (deterministic, documented here as the single source):
 *   1. Home-project agent — agents.projectId === projectId (project-native wins).
 *   2. Any other non-stock member agent (shared member added explicitly).
 *   3. Stock agent (origin='stock') — last; stock names are reserved and
 *      should never collide with user-created names in practice.
 *
 *  With no projectId only stock agents are visible. Returns null if no match. */
export function resolveAgentForDispatch(
  name: string,
  projectId?: ULID | null,
): PodAgentRow | null {
  const visible = listProjectVisibleAgents(projectId);
  const matches = visible.filter((a) => a.name === name);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;
  // Collision: apply precedence.
  const homeMatch = matches.find((a) => a.projectId === projectId);
  if (homeMatch) return homeMatch;
  const memberMatch = matches.find((a) => a.origin !== 'stock');
  if (memberMatch) return memberMatch;
  return matches[0]!;
}

/** Read the full pod the materialiser (17a.3) needs to render `.md` +
 *  `mcp.json` + env vars at spawn time.
 *
 *  Secrets are resolved by agentId only (Phase-1 re-key: unique index on
 *  (agentId, envVarName)). Shared agents carry the same secrets across all
 *  member projects — no scope/projectId filter at spawn.
 *
 *  Returns null when no visible agent with `name` exists for the project. */
export function getPodForSpawn(name: string, projectId?: ULID | null): PodSpawnBundle | null {
  const agent = resolveAgentForDispatch(name, projectId);
  if (!agent) return null;
  // Context docs hang off the agent row alone — already keyed by agentId.
  const docs = listContextDocsForScope({ scope: { agentId: agent.id } });
  const contextDocsForSpawn: AgentContextDoc[] = docs.map(toAgentContextDoc);
  return {
    agent,
    contextDocs: contextDocsForSpawn,
    // Secrets key by agentId across all member projects (shared-everything).
    secrets: listSecrets({ agentId: agent.id }),
  };
}

/** Project a full context_docs row down to the spawn-bundle shape the
 *  materialiser consumes (@pc/runtime cannot import @pc/db). */
export function toAgentContextDoc(row: ContextDocRow): AgentContextDoc {
  return { id: row.id, title: row.title, body: row.body, updatedAt: row.updatedAt };
}
