// Section 17d.1 — HTTP routes for the pod tables.
//
// Mounted on the main Hono app via registerPodRoutes(); also imported by
// pod-routes.test.ts so the tests exercise the same handler code paths the
// production server runs.
//
// Both `scope: 'global'` and `scope: 'project'` are supported. Project-scope
// rows require `projectId`. GET /api/agents/pods accepts `?projectId=<ulid>`
// to merge globals with that project's project-scope rows (the union the
// Agents tab displays); without the query, returns globals only.
//
// Mutating routes emit two effects after the DB write:
//   1. `announcePod(...)` / `announcePodDeleted(...)` — writes a durable
//      `pod.changed` live_outbox row IN-TXN (slice 015b-tail); the live-relay
//      drains it post-commit and fans the canonical frame. Global pods emit a
//      global frame (reaches every project socket); project pods emit a project
//      frame. No more hand-fanout — the relay is the sole delivery path.
//   2. `deps.onPodChanged?.(name, change)` — optional restart-on-edit hook
//      (17d.10). The default test wiring omits it; production wires the
//      agent-run-manager + project-runtime kill+respawn paths.
//
// Secrets never leak values over the wire: GET /:id strips `valuePlaintext`
// from secret rows; the secret create body accepts the value but it goes
// straight into the DB and is never read back through the routes.

import type { Hono } from 'hono';
import {
  bumpAgentRev,
  cloneAgentToProject,
  createAgent,
  createContextDoc,
  createSecret,
  deleteSecret,
  deleteMcpAttachmentByPair,
  getAgentById,
  getContextDoc,
  getContextDocReadStats,
  getMcpServerRegistry,
  getSecret,
  listAgentAudit,
  listAgents,
  listContextDocsForScope,
  listMcpAttachmentsForAgent,
  listProjectVisibleAgents,
  listSecrets,
  promoteAgentToGlobal,
  softDeleteAgent,
  softDeleteContextDoc,
  updateAgent,
  updateContextDoc,
  upsertMcpAttachment,
} from '@pc/db';
import type { ContextDocRow } from '@pc/db';
import type {
  AgentEffort,
  AgentMcpAttachmentRow,
  AgentModel,
  PodAgentRow,
  PodAuditActor,
  PodAuditField,
  PodScope,
  PodSecretRow,
  ULID,
} from '@pc/domain';
import { POD_AUDIT_ACTORS, POD_AUDIT_FIELDS } from '@pc/domain';
import { recordToolReadFromQuery } from '../features/context-docs/routes.ts';
import { announcePod, announcePodDeleted } from '../services/pod-writer.ts';

export type PodMutationKind = 'created' | 'updated' | 'deleted';

export interface PodRoutesDeps {
  /** Optional restart-on-edit hook (17d.10). Called after every successful
   *  pod mutation lands its outbox row. Receives the pod's name + change
   *  kind so the caller can decide whether to kill+respawn anything. */
  onPodChanged?: (podName: string, change: PodMutationKind) => void;
  /** Reset a stock pod's scalar fields to its seeded canonical content.
   *  Injected so tests can stub it without dragging the seed modules + their
   *  large prompt-text imports into the test bundle. Production wires this
   *  to `resetStockPodToDefault` from services/stock-pod-reset.ts. */
  resetStockPodToDefault?: (
    name: string,
    reason: string,
  ) => { agent: PodAgentRow | null; resetFields: string[] };
  /** Section 36+ — drift detector for a single live pod. Returns null for
   *  non-stock pods (or pods without canonical content), `[]` for pristine
   *  stock pods, or the array of drifted SEED_OWNED_FIELDS names. Injected
   *  for the same reason as resetStockPodToDefault — tests don't pull the
   *  large prompt-text canonical content. */
  detectStockPodDrift?: (pod: PodAgentRow) => string[] | null;
  /** Section 36+ — names of every stock pod the server canonically ships.
   *  Drives the "Reset all to default" summary shape. */
  listCanonicalStockPodNames?: () => string[];
}

/** Public projection of a secret — `valuePlaintext` is stripped. Never sent
 *  back through any read path. */
export interface PublicPodSecret {
  id: ULID;
  agentId: ULID;
  envVarName: string;
  createdAt: number;
}

function publicSecret(row: PodSecretRow): PublicPodSecret {
  return {
    id: row.id,
    agentId: row.agentId,
    envVarName: row.envVarName,
    createdAt: row.createdAt,
  };
}

/** Context doc + its read stats (Phase B/0056). `readCount === 0` with
 *  `lastReadAt === null` renders as "never read" in the UI. */
export type ContextDocWithReadStats = ContextDocRow & {
  readCount: number;
  lastReadAt: number | null;
};

export interface PodBundle {
  agent: PodAgentRow;
  contextDocs: ContextDocWithReadStats[];
  secrets: PublicPodSecret[];
}

/** Join read receipts onto a doc list. Best-effort — stats default to
 *  never-read if the receipt query fails. */
function withReadStats(docs: ContextDocRow[]): ContextDocWithReadStats[] {
  let stats = new Map<ULID, { readCount: number; lastReadAt: number }>();
  try {
    stats = getContextDocReadStats(docs.map((d) => d.id));
  } catch {
    /* best-effort */
  }
  return docs.map((d) => {
    const s = stats.get(d.id);
    return { ...d, readCount: s?.readCount ?? 0, lastReadAt: s?.lastReadAt ?? null };
  });
}

/** Assemble the full bundle for the modal mount. Lives next to the routes so
 *  the test can call it directly. */
export function getPodBundle(agentId: ULID): PodBundle | null {
  const agent = getAgentById(agentId);
  if (!agent) return null;
  return {
    agent,
    contextDocs: withReadStats(listContextDocsForScope({ scope: { agentId: agent.id } })),
    secrets: listSecrets({ agentId: agent.id, scope: agent.scope }).map(publicSecret),
  };
}

/** Effort + audit-field + audit-actor validators. Routes
 *  use these to reject unknown enum strings before hitting the repo. */
const KNOWN_EFFORTS: ReadonlySet<AgentEffort> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function asEffortOrNull(v: unknown): AgentEffort | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'string' && KNOWN_EFFORTS.has(v as AgentEffort)) {
    return v as AgentEffort;
  }
  throw new Error(`invalid effort: ${JSON.stringify(v)}`);
}

function asModelOrNull(v: unknown): AgentModel | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'string' && v.length > 0) return v as AgentModel;
  throw new Error(`invalid model: ${JSON.stringify(v)}`);
}

function asMaxTurnsOrNull(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  throw new Error(`invalid maxTurns: ${JSON.stringify(v)}`);
}

function asToolsArray(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
    return v as string[];
  }
  throw new Error(`invalid tools: expected string[]`);
}

function asActor(v: unknown): PodAuditActor | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && (POD_AUDIT_ACTORS as readonly string[]).includes(v)) {
    return v as PodAuditActor;
  }
  throw new Error(`invalid actor: ${JSON.stringify(v)}`);
}

/** Mutating routes accept optional `actor` + `reason` in the body so callers
 *  can identify themselves to the audit log (`'orchestrator'` for MCP-driven
 *  writes, `'user'` for UI writes). Falls back to the route's default when
 *  absent or empty. Caller is expected to pass a known reason slug
 *  (`'mcp-create'`, `'ui-edit'`, etc.); free-form strings are permitted. */
function auditFromBody(
  body: Record<string, unknown>,
  defaultActor: PodAuditActor,
  defaultReason: string,
): { actor: PodAuditActor; reason: string } {
  const actor = asActor(body.actor) ?? defaultActor;
  const reason =
    typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim()
      : defaultReason;
  return { actor, reason };
}

/** DELETE has no body; accept the same `actor` + `reason` overrides via query
 *  string. Same defaults as the body path. */
function auditFromQuery(
  qs: URLSearchParams,
  defaultActor: PodAuditActor,
  defaultReason: string,
): { actor: PodAuditActor; reason: string } {
  const actor = asActor(qs.get('actor') ?? undefined) ?? defaultActor;
  const reasonRaw = qs.get('reason');
  const reason =
    typeof reasonRaw === 'string' && reasonRaw.trim().length > 0
      ? reasonRaw.trim()
      : defaultReason;
  return { actor, reason };
}

function asAuditField(v: unknown): PodAuditField | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && (POD_AUDIT_FIELDS as readonly string[]).includes(v)) {
    return v as PodAuditField;
  }
  throw new Error(`invalid field: ${JSON.stringify(v)}`);
}

/** Register every pod route on `app`. Idempotent — call once per Hono
 *  instance. */
export function registerPodRoutes(app: Hono, deps: PodRoutesDeps): void {
  // --- /api/agents/pods ---------------------------------------------------

  /** List live pods. Without `?projectId`: globals only. With
   *  `?projectId=<ulid>`: project-scope rows for the project + stock globals
   *  (the Agents-tab view). Global user-created pods are excluded from the
   *  project view — they belong only to the global/create-agent surface.
   *  Each row carries `driftedFields: string[] | null`
   *  (Section 36+ — null for non-stock, [] for pristine stock, populated for
   *  customised stock) so the UI can render the "Customized" pill without a
   *  second round trip. */
  app.get('/api/agents/pods', (c) => {
    const qs = new URL(c.req.url).searchParams;
    const projectId = qs.get('projectId') as ULID | null;
    // With a projectId: project-scope pods + built-in (stock) globals only
    // (shared `listProjectVisibleAgents` — same path/rule as the orchestrator's
    // {{AVAILABLE_AGENTS}}; global user-created pods are excluded from the
    // project view). Without one: the global management surface shows ALL
    // globals so the user can manage / copy them.
    const pods = projectId
      ? listProjectVisibleAgents(projectId)
      : listAgents({ scope: 'global' });
    const detectDrift = deps.detectStockPodDrift;
    const annotated = pods.map((p) => ({
      ...p,
      driftedFields: detectDrift ? detectDrift(p) : null,
    }));
    return c.json({ ok: true, pods: annotated });
  });

  /** Full bundle for the detail modal: agent row + knowledge + secret
   *  metadata (no values) + mcp servers. Section 36+ — drift info attached
   *  so PodDetailModal can show the "Customized" pill + "Reset to default"
   *  affordance in lockstep with what GET /api/agents/pods returns. */
  app.get('/api/agents/pods/:id', (c) => {
    const id = c.req.param('id') as ULID;
    const bundle = getPodBundle(id);
    if (!bundle) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    const driftedFields = deps.detectStockPodDrift
      ? deps.detectStockPodDrift(bundle.agent)
      : null;
    return c.json({ ok: true, ...bundle, driftedFields });
  });

  /** Audit log for a pod. Filters: actor, field, beforeCreatedAt, limit. */
  app.get('/api/agents/pods/:id/audit', (c) => {
    const id = c.req.param('id') as ULID;
    if (!getAgentById(id)) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    try {
      const actor = asActor(c.req.query('actor'));
      const field = asAuditField(c.req.query('field'));
      const limitRaw = c.req.query('limit');
      const beforeRaw = c.req.query('beforeCreatedAt');
      const limit = limitRaw ? Number(limitRaw) : undefined;
      const beforeCreatedAt = beforeRaw ? Number(beforeRaw) : undefined;
      if (limit !== undefined && !(Number.isFinite(limit) && limit > 0)) {
        return c.json({ ok: false, error: 'invalid limit' }, 400);
      }
      if (beforeCreatedAt !== undefined && !Number.isFinite(beforeCreatedAt)) {
        return c.json({ ok: false, error: 'invalid beforeCreatedAt' }, 400);
      }
      const rows = listAgentAudit({
        agentId: id,
        ...(limit !== undefined ? { limit } : {}),
        ...(beforeCreatedAt !== undefined ? { beforeCreatedAt } : {}),
        ...(actor !== undefined ? { actor } : {}),
        ...(field !== undefined ? { field } : {}),
      });
      return c.json({ ok: true, rows });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  /** Create a new pod. Body: name + scope ('global' default | 'project') +
   *  projectId (required when scope='project') + optional fields. */
  app.post('/api/agents/pods', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ ok: false, error: 'name required' }, 400);
    const scope: PodScope = body.scope === 'project' ? 'project' : 'global';
    let projectId: ULID | null = null;
    if (scope === 'project') {
      if (typeof body.projectId !== 'string' || !body.projectId) {
        return c.json({ ok: false, error: 'projectId required when scope="project"' }, 400);
      }
      projectId = body.projectId as ULID;
    }
    let row: PodAgentRow;
    try {
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      const description = typeof body.description === 'string' ? body.description : '';
      row = createAgent(
        {
          name,
          scope,
          ...(projectId ? { projectId } : {}),
          prompt,
          description,
          ...(body.model !== undefined ? { model: asModelOrNull(body.model) ?? null } : {}),
          ...(body.effort !== undefined ? { effort: asEffortOrNull(body.effort) ?? null } : {}),
          ...(body.maxTurns !== undefined
            ? { maxTurns: asMaxTurnsOrNull(body.maxTurns) ?? null }
            : {}),
          ...(body.tools !== undefined ? { tools: asToolsArray(body.tools) ?? [] } : {}),
        },
        auditFromBody(body, 'user', 'ui-create'),
      );
    } catch (err) {
      const msg = (err as Error).message;
      const status = /required|invalid|UNIQUE/i.test(msg) ? 400 : 500;
      return c.json({ ok: false, error: msg }, status);
    }
    announcePod(row.id, 'created');
    deps.onPodChanged?.(row.name, 'created');
    return c.json({ ok: true, pod: row }, 201);
  });

  /** Promote a project-scoped pod to global. Stock pods are seeded global and
   *  shouldn't surface this route in practice, but it returns 400 if the row
   *  is already global. UNIQUE violation on a global name collision → 409. */
  app.post('/api/agents/pods/:id/promote-to-global', async (c) => {
    const id = c.req.param('id') as ULID;
    const existing = getAgentById(id);
    if (!existing) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    if (existing.scope === 'global') {
      return c.json({ ok: false, error: 'pod is already global' }, 400);
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      /* empty body is fine */
    }
    let row: PodAgentRow | null;
    try {
      row = promoteAgentToGlobal(id, auditFromBody(body, 'user', 'ui-promote'));
    } catch (err) {
      const msg = (err as Error).message;
      if (/UNIQUE/i.test(msg)) {
        return c.json(
          { ok: false, error: `a global pod named "${existing.name}" already exists` },
          409,
        );
      }
      return c.json({ ok: false, error: msg }, 400);
    }
    if (!row) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    announcePod(row.id, 'updated');
    deps.onPodChanged?.(row.name, 'updated');
    return c.json({ ok: true, pod: row });
  });

  /** Clone a pod into a target project as a project-scope row. Copies the
   *  scalar fields + knowledge + mcp servers; secrets are intentionally NOT
   *  copied. Returns the new pod row and counts of cloned content rows.
   *  Body: `{ projectId: ULID, name?: string, actor?, reason? }`. */
  app.post('/api/agents/pods/:id/clone-to-project', async (c) => {
    const sourceId = c.req.param('id') as ULID;
    const source = getAgentById(sourceId);
    if (!source) return c.json({ ok: false, error: `unknown pod: ${sourceId}` }, 404);
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    const targetProjectId = body.projectId;
    if (typeof targetProjectId !== 'string' || !targetProjectId) {
      return c.json({ ok: false, error: 'projectId is required' }, 400);
    }
    const nameOverride =
      typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
    let result;
    try {
      result = cloneAgentToProject(
        {
          sourceId,
          targetProjectId: targetProjectId as ULID,
          name: nameOverride,
        },
        auditFromBody(body, 'user', 'ui-clone'),
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (/already exists/i.test(msg)) {
        return c.json({ ok: false, error: msg }, 409);
      }
      return c.json({ ok: false, error: msg }, 400);
    }
    announcePod(result.agent.id, 'created');
    deps.onPodChanged?.(result.agent.name, 'created');
    return c.json({ ok: true, pod: result.agent, copied: result.copied }, 201);
  });

  /** Reset a stock pod's scalar fields to its canonical seed content. Only
   *  stock pods are valid targets; any other pod returns
   *  400. Knowledge / secrets / registry attachments are untouched.
   *  Body: `{ actor?, reason? }` — actor defaults to 'user', reason defaults
   *  to 'ui-reset-to-default'. */
  app.post('/api/agents/pods/:id/reset-to-default', async (c) => {
    const id = c.req.param('id') as ULID;
    const existing = getAgentById(id);
    if (!existing) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    if (existing.origin !== 'stock') {
      return c.json(
        { ok: false, error: 'reset-to-default is only available for stock pods' },
        400,
      );
    }
    if (!deps.resetStockPodToDefault) {
      return c.json(
        { ok: false, error: 'reset-to-default not wired on this server' },
        500,
      );
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      /* empty body is fine */
    }
    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'ui-reset-to-default';
    const result = deps.resetStockPodToDefault(existing.name, reason);
    if (!result.agent) {
      return c.json({ ok: false, error: 'pod not found in canonical content' }, 500);
    }
    if (result.resetFields.length > 0) {
      // Use route :id (the live DB row) — result.agent.id may be from a stub in tests.
      announcePod(id, 'updated');
      deps.onPodChanged?.(result.agent.name, 'updated');
    }
    return c.json({
      ok: true,
      pod: result.agent,
      resetFields: result.resetFields,
    });
  });

  /** Section 36+ — Reset every drifted stock pod to its seeded canonical
   *  content in one call. Walks the canonical roster, runs drift detection
   *  on each live row, calls `resetStockPodToDefault` for the drifted ones.
   *  Returns a summary of which pods were touched and which were already
   *  pristine. Body: `{ reason?: string }` — defaults to 'ui-reset-all'.
   *  Audit rows land as `actor='user'` for each per-pod reset (same as the
   *  single-pod path). */
  app.post('/api/agents/pods/reset-all-stock-to-default', async (c) => {
    if (!deps.resetStockPodToDefault || !deps.detectStockPodDrift || !deps.listCanonicalStockPodNames) {
      return c.json(
        { ok: false, error: 'reset-all not wired on this server' },
        500,
      );
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      /* empty body is fine */
    }
    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'ui-reset-all';

    const names = deps.listCanonicalStockPodNames();
    const reset: Array<{ name: string; resetFields: string[] }> = [];
    const unchanged: string[] = [];
    const missing: string[] = [];

    for (const name of names) {
      // Look up the live row (project-agnostic — stock pods are global-scope).
      const live = listAgents({ scope: 'global' }).find((p) => p.name === name);
      if (!live) {
        missing.push(name);
        continue;
      }
      const drifted = deps.detectStockPodDrift(live);
      if (!drifted || drifted.length === 0) {
        unchanged.push(name);
        continue;
      }
      const result = deps.resetStockPodToDefault(name, reason);
      if (!result.agent || result.resetFields.length === 0) {
        // Defensive — detectStockPodDrift said drifted but the reset said no
        // change. Could happen if a row was user-edited then concurrent-reset
        // between the detect + reset calls. Surface as unchanged.
        unchanged.push(name);
        continue;
      }
      reset.push({ name, resetFields: result.resetFields });
      // Use live.id (the actual DB row) — result.agent.id may differ in tests.
      announcePod(live.id, 'updated');
      deps.onPodChanged?.(name, 'updated');
    }

    return c.json({ ok: true, reset, unchanged, missing });
  });

  /** Patch a pod's scalar fields. Multi-field updates audit under a shared
   *  change-set (handled by the repo). Returns the post-update row. */
  app.patch('/api/agents/pods/:id', async (c) => {
    const id = c.req.param('id') as ULID;
    const existing = getAgentById(id);
    if (!existing) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    // Built-in (stock) pods are controlled centrally — the code seed is their
    // single source of truth and edits are rejected here (the only scalar-edit
    // door; pc_update_agent + the Agents-tab editor both route through it). To
    // customize a built-in, clone it into a project ("Add agent") and edit the
    // copy. "Reset to default" + system reseeds use other doors, not this one.
    if (existing.origin === 'stock') {
      return c.json(
        {
          ok: false,
          error:
            'Built-in agents are controlled centrally and cannot be edited. Clone this agent into your project (Add agent) to customize it.',
          kind: 'stock-locked' as const,
        },
        409,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    let updated: PodAgentRow | null;
    try {
      const patch: Parameters<typeof updateAgent>[1] = {};
      if (typeof body.name === 'string') patch.name = body.name.trim();
      if (typeof body.prompt === 'string') patch.prompt = body.prompt;
      if (typeof body.description === 'string') patch.description = body.description;
      if (body.tools !== undefined) {
        const tools = asToolsArray(body.tools);
        if (tools !== undefined) patch.tools = tools;
      }
      if (body.model !== undefined) patch.model = asModelOrNull(body.model) ?? null;
      if (body.effort !== undefined) patch.effort = asEffortOrNull(body.effort) ?? null;
      if (body.maxTurns !== undefined) patch.maxTurns = asMaxTurnsOrNull(body.maxTurns) ?? null;
      if (patch.name === '') {
        return c.json({ ok: false, error: 'name cannot be empty' }, 400);
      }
      updated = updateAgent(id, patch, auditFromBody(body, 'user', 'ui-edit'));
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    if (!updated) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    announcePod(updated.id, 'updated');
    deps.onPodChanged?.(updated.name, 'updated');
    return c.json({ ok: true, pod: updated });
  });

  /** Soft-delete a pod. Stock specialists are 409 (deleting them would
   *  orphan running CC sessions that depend on the seeded shape). Reads the
   *  `origin` column rather than a hardcoded name list (Section 36). */
  app.delete('/api/agents/pods/:id', (c) => {
    const id = c.req.param('id') as ULID;
    const existing = getAgentById(id);
    if (!existing) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    if (existing.origin === 'stock') {
      return c.json(
        {
          ok: false,
          error: `Stock specialists can't be deleted. Edit the prompt instead.`,
          kind: 'stock-specialist' as const,
        },
        409,
      );
    }
    const qs = new URL(c.req.url).searchParams;
    const deleted = softDeleteAgent(id, auditFromQuery(qs, 'user', 'ui-delete'));
    if (!deleted) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    announcePodDeleted(id, existing.name, existing.scope, existing.projectId);
    deps.onPodChanged?.(existing.name, 'deleted');
    return c.json({ ok: true });
  });

  // --- agent context docs ---------------------------------------------------
  // Migration 0055: per-agent reference docs are agent-scoped context_docs
  // rows. This route family replaces the old /knowledge routes 1:1 and is the
  // reachable surface for GLOBAL pods (the project route family requires a
  // projectId). Same repo underneath as the project routes — one path.

  app.get('/api/agents/pods/:id/context-docs', (c) => {
    const id = c.req.param('id') as ULID;
    if (!getAgentById(id)) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    const docs = withReadStats(listContextDocsForScope({ scope: { agentId: id } }));
    return c.json({ ok: true, contextDocs: docs });
  });

  app.post('/api/agents/pods/:id/context-docs', async (c) => {
    const id = c.req.param('id') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return c.json({ ok: false, error: 'title required' }, 400);
    let row: ContextDocRow;
    try {
      row = createContextDoc(
        {
          scope: { agentId: id },
          title,
          body: typeof body.body === 'string' ? body.body : '',
          author: typeof body.author === 'string' && body.author ? body.author : 'user',
        },
        auditFromBody(body, 'user', 'ui-create-context-doc'),
      );
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    bumpAgentRev(id);
    announcePod(id, 'updated');
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true, contextDoc: withReadStats([row])[0] }, 201);
  });

  /** Read a single attached doc. Worker agents call this at runtime (via
   *  `pc_get_context_doc`) to pull reference material; the orchestrator uses
   *  it to show doc content inline. */
  app.get('/api/agents/pods/:id/context-docs/:docId', (c) => {
    const id = c.req.param('id') as ULID;
    const docId = c.req.param('docId') as ULID;
    if (!getAgentById(id)) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    const row = getContextDoc(docId);
    if (!row || row.agentId !== id) {
      return c.json({ ok: false, error: `unknown context doc: ${docId}` }, 404);
    }
    recordToolReadFromQuery(docId, new URL(c.req.url).searchParams);
    return c.json({ ok: true, contextDoc: withReadStats([row])[0] });
  });

  app.patch('/api/agents/pods/:id/context-docs/:docId', async (c) => {
    const id = c.req.param('id') as ULID;
    const docId = c.req.param('docId') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    const existing = getContextDoc(docId);
    if (!existing || existing.agentId !== id) {
      return c.json({ ok: false, error: `unknown context doc: ${docId}` }, 404);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    let updated: ContextDocRow | null;
    try {
      const patch: { title?: string; body?: string } = {};
      if (typeof body.title === 'string') patch.title = body.title.trim();
      if (typeof body.body === 'string') patch.body = body.body;
      updated = updateContextDoc(
        docId,
        patch,
        auditFromBody(body, 'user', 'ui-edit-context-doc'),
      );
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    if (!updated) return c.json({ ok: false, error: `unknown context doc: ${docId}` }, 404);
    bumpAgentRev(id);
    announcePod(id, 'updated');
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true, contextDoc: withReadStats([updated])[0] });
  });

  /** Soft delete (replaces the old hard delete — every read filters
   *  deletedAt, and read-history survives for Phase B staleness). */
  app.delete('/api/agents/pods/:id/context-docs/:docId', (c) => {
    const id = c.req.param('id') as ULID;
    const docId = c.req.param('docId') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    const existing = getContextDoc(docId);
    if (!existing || existing.agentId !== id) {
      return c.json({ ok: false, error: `unknown context doc: ${docId}` }, 404);
    }
    const qs = new URL(c.req.url).searchParams;
    const removed = softDeleteContextDoc(
      docId,
      auditFromQuery(qs, 'user', 'ui-delete-context-doc'),
    );
    if (!removed) return c.json({ ok: false, error: `unknown context doc: ${docId}` }, 404);
    bumpAgentRev(id);
    announcePod(id, 'updated');
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true });
  });

  // --- secrets ------------------------------------------------------------

  app.post('/api/agents/pods/:id/secrets', async (c) => {
    const id = c.req.param('id') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    const envVarName = typeof body.envVarName === 'string' ? body.envVarName.trim() : '';
    const valuePlaintext = typeof body.valuePlaintext === 'string' ? body.valuePlaintext : '';
    if (!envVarName) {
      return c.json({ ok: false, error: 'envVarName required' }, 400);
    }
    let row: PodSecretRow;
    try {
      // Section 22.2 — secrets inherit agent.scope/projectId. See knowledge
      // route above for the rationale.
      row = createSecret(
        {
          agentId: id,
          scope: agent.scope,
          projectId: agent.projectId ?? null,
          envVarName,
          valuePlaintext,
        },
        auditFromBody(body, 'user', 'ui-create-secret'),
      );
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    bumpAgentRev(id);
    announcePod(id, 'updated');
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true, secret: publicSecret(row) }, 201);
  });

  app.delete('/api/agents/pods/:id/secrets/:secretId', (c) => {
    const id = c.req.param('id') as ULID;
    const secretId = c.req.param('secretId') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    const existing = getSecret(secretId);
    if (!existing || existing.agentId !== id) {
      return c.json({ ok: false, error: `unknown secret: ${secretId}` }, 404);
    }
    const qs = new URL(c.req.url).searchParams;
    const removed = deleteSecret(secretId, auditFromQuery(qs, 'user', 'ui-delete-secret'));
    if (!removed) return c.json({ ok: false, error: `unknown secret: ${secretId}` }, 404);
    bumpAgentRev(id);
    announcePod(id, 'updated');
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true });
  });

  // --- registry mcp attachments (pc-pty-chat-359 P3) -------------------------
  //
  // Links an agent to a registered MCP server (mcp_servers) with a per-tool
  // selection. These are distinct from the inline agent_mcp_servers rows above.
  // Routes: GET list · PUT upsert · DELETE detach.

  /** List all registry server attachments for this agent. */
  app.get('/api/agents/pods/:id/mcp-attachments', (c) => {
    const id = c.req.param('id') as ULID;
    if (!getAgentById(id)) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    const attachments: AgentMcpAttachmentRow[] = listMcpAttachmentsForAgent(id);
    return c.json({ ok: true, attachments });
  });

  /** Attach a registry server to this agent, or update its tool selection.
   *  Body: `{ enabledTools: '*' | string[] }`.
   *  Idempotent — re-PUT with different tool selection updates in-place. */
  app.put('/api/agents/pods/:id/mcp-attachments/:mcpServerId', async (c) => {
    const id = c.req.param('id') as ULID;
    const mcpServerId = c.req.param('mcpServerId') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    const registryServer = getMcpServerRegistry(mcpServerId);
    if (!registryServer) {
      return c.json({ ok: false, error: `unknown registry server: ${mcpServerId}` }, 404);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    let enabledTools: string[] | '*';
    try {
      enabledTools = asEnabledTools(body.enabledTools);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    const attachment = upsertMcpAttachment({ agentId: id, mcpServerId, enabledTools });
    bumpAgentRev(id);
    announcePod(id, 'updated');
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true, attachment });
  });

  /** Detach a registry server from this agent. Idempotent — 200 even if no
   *  attachment existed. */
  app.delete('/api/agents/pods/:id/mcp-attachments/:mcpServerId', (c) => {
    const id = c.req.param('id') as ULID;
    const mcpServerId = c.req.param('mcpServerId') as ULID;
    const agent = getAgentById(id);
    if (!agent) return c.json({ ok: false, error: `unknown pod: ${id}` }, 404);
    deleteMcpAttachmentByPair(id, mcpServerId);
    bumpAgentRev(id);
    announcePod(id, 'updated');
    deps.onPodChanged?.(agent.name, 'updated');
    return c.json({ ok: true });
  });
}

// ── Helpers (attachment) ──────────────────────────────────────────────────────

function asEnabledTools(v: unknown): string[] | '*' {
  if (v === '*') return '*';
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  throw new Error('enabledTools must be "*" or a string[]');
}
