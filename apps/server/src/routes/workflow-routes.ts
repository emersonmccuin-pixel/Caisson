// Section 19.17 — HTTP routes for the promoted `workflows` table.
//
// Mirrors pod-routes.ts: rail-friendly list (globals ∪ project rows),
// detail-view get, scalar create/update, soft-delete with in-flight guard,
// promote-to-global, duplicate, fire-by-id, audit log.
//
// Slice 015b — every mutating route now ONLY writes a `workflow.definition.changed`
// row to the slice-002 `live_outbox` inside its DB txn (`emitDefinitionFact`).
// The slice-015a relay drains that committed row to the subscribed sockets; the
// web `useProjectWorkflows` hook refetches on the relay frame (entity
// `workflow-definition`). The legacy hand-fanned `workflow-changed` envelopes +
// frame double-emit are gone — delivery flows through the door only.
//
// Validation: bodies may carry either `def: object` (the workflow graph) or
// `yaml: string` (raw editor). Both flow through the same parse + validate +
// serialize pipeline so the DB row's `yaml` column is always canonical-form
// + `parsedDefinition` is always reconciled. Invalid bodies land as
// `status='invalid'` rows with `parseError` set — same shape as the 19.13
// boot importer's failed-parse path.
//
// In-flight runs guard on DELETE: any v2 run for this project whose
// `workflowId` matches the row's `slug` and whose status is in
// {pending, running, paused} blocks the soft-delete with a 409. Callers
// can cancel-and-delete via the `?cancel=1` escape (mirrors 4f.2 lock).

import { createHash } from 'node:crypto';

import type { Hono } from 'hono';
import {
  getAgentByName,
  getDb,
  insertLiveEvent,
  listWorkflowAudit,
  workflowsRepo,
  type WorkflowAuditInput,
} from '@pc/db';
import type {
  PodAuditActor,
  PodScope,
  ULID,
  WorkflowAuditField,
  WorkflowRow,
  WorkflowV2,
} from '@pc/domain';
import { POD_AUDIT_ACTORS, WORKFLOW_AUDIT_FIELDS } from '@pc/domain';
import {
  parseWorkflowV2Text,
  serializeWorkflowV2,
  validateWorkflowV2,
} from '@pc/workflows';
import type { WorkflowDefinitionChange } from '@pc/contracts';
import { toWorkflowDefinitionDto } from '@pc/app-services';

export type WorkflowMutationKind = 'created' | 'updated' | 'deleted';

export interface WorkflowRoutesDeps {
  /** Count in-flight v2 runs for a (projectId, workflowSlug) pair. Blocks
   *  soft-delete unless the caller passes `?cancel=1`. Repo dependency
   *  injected so tests can stub it without dragging the runs table in. */
  countInFlightRuns: (projectId: ULID, slug: string) => number;
  /** Optional: cancel every in-flight run for (projectId, slug). Called
   *  from DELETE when `?cancel=1` is set. */
  cancelInFlightRuns?: (projectId: ULID, slug: string) => Promise<void> | void;
  /** Fire a persisted workflow by parsed definition. The route resolves the
   *  DB row, casts `parsedDefinition` to the v2 shape, and invokes this. */
  fireWorkflow: (
    projectId: ULID,
    def: WorkflowV2.Workflow,
    trigger: WorkflowV2.WorkflowTrigger,
  ) => Promise<{ runId: ULID; rootWorkItemId: ULID }>;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function asActor(v: unknown): PodAuditActor | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && (POD_AUDIT_ACTORS as readonly string[]).includes(v)) {
    return v as PodAuditActor;
  }
  throw new Error(`invalid actor: ${JSON.stringify(v)}`);
}

function asAuditField(v: unknown): WorkflowAuditField | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && (WORKFLOW_AUDIT_FIELDS as readonly string[]).includes(v)) {
    return v as WorkflowAuditField;
  }
  throw new Error(`invalid field: ${JSON.stringify(v)}`);
}

function auditFromBody(
  body: Record<string, unknown>,
  defaultActor: PodAuditActor,
  defaultReason: string,
): WorkflowAuditInput {
  const actor = asActor(body.actor) ?? defaultActor;
  const reason =
    typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim()
      : defaultReason;
  return { actor, reason };
}

function auditFromQuery(
  qs: URLSearchParams,
  defaultActor: PodAuditActor,
  defaultReason: string,
): WorkflowAuditInput {
  const actor = asActor(qs.get('actor') ?? undefined) ?? defaultActor;
  const reasonRaw = qs.get('reason');
  const reason =
    typeof reasonRaw === 'string' && reasonRaw.trim().length > 0
      ? reasonRaw.trim()
      : defaultReason;
  return { actor, reason };
}

interface NormalisedDef {
  /** Canonical YAML text (the same string that hits `workflows.yaml`). */
  yaml: string;
  yamlHash: string;
  /** Parsed v2 graph. Null when `status === 'invalid'`. */
  parsedDefinition: WorkflowV2.Workflow | null;
  status: 'active' | 'invalid';
  /** Parser/validator error string. Non-null only when `status === 'invalid'`. */
  parseError: string | null;
  /** Slug + display fields hoisted out of the def for the DB row. Mirrors
   *  the 19.13 importer. Null pieces fall back to `slug` at the caller. */
  slug: string;
  name: string;
  description: string | null;
  disabled: boolean;
}

/**
 * Normalise a body that may carry `{ def }` or `{ yaml }` into the shape the
 * DB row expects. `expectedSlug` is consulted for PUT (id-immutable) — if the
 * body's slug doesn't match the existing row, we 400 at the caller.
 */
function normaliseDef(input: {
  def?: unknown;
  yaml?: unknown;
  expectedSlug?: string;
}): NormalisedDef | { error: string } {
  let yamlText: string;
  let parsed:
    | { ok: true; workflow: WorkflowV2.Workflow }
    | { ok: false; errors: string[] };

  if (typeof input.yaml === 'string' && input.yaml.trim().length > 0) {
    yamlText = input.yaml;
    // Slug-rename detection: parseWorkflowV2Text's `expectedId` silently
    // coerces the body's `id` to match (filename-as-authority semantics from
    // the on-disk importer), which would mask a rename in this code path.
    // Peek at the raw `id:` line first so we can reject the mismatch before
    // the parser swallows it. Cheap regex over the leading region of the
    // file is enough — a fully malformed YAML still parses (or fails)
    // downstream the normal way.
    if (input.expectedSlug) {
      const m = yamlText.match(/^\s*id\s*:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/m);
      if (m && m[1] !== input.expectedSlug) {
        return {
          error: `def.id "${m[1]}" does not match the workflow's slug "${input.expectedSlug}" — renames are not supported in place; duplicate + delete instead`,
        };
      }
    }
    const raw = parseWorkflowV2Text(yamlText, {
      ...(input.expectedSlug ? { expectedId: input.expectedSlug } : {}),
    });
    if (raw.ok) {
      parsed = { ok: true, workflow: raw.workflow };
    } else if ('errors' in raw) {
      parsed = { ok: false, errors: raw.errors };
    } else {
      parsed = { ok: false, errors: ['not a v2 workflow (missing `version: 2` marker)'] };
    }
  } else if (input.def && typeof input.def === 'object') {
    const def = input.def as WorkflowV2.Workflow;
    const validation = validateWorkflowV2(def);
    if (!validation.ok) {
      // Validator errors → invalid row; still need a canonical yaml string
      // so the Raw YAML tab has something to load. Serialize the input as-is
      // (serializer tolerates partial shapes).
      const draftYaml = serializeWorkflowV2(def);
      const slugRaw = typeof def.id === 'string' ? def.id : '';
      return {
        yaml: draftYaml,
        yamlHash: sha256(draftYaml),
        parsedDefinition: null,
        status: 'invalid',
        parseError: validation.errors.join('; '),
        slug: input.expectedSlug ?? slugRaw,
        name: typeof def.name === 'string' && def.name ? def.name : slugRaw,
        description:
          typeof def.description === 'string' && def.description ? def.description : null,
        disabled: def.disabled === true,
      };
    }
    yamlText = serializeWorkflowV2(def);
    parsed = { ok: true, workflow: def };
  } else {
    return { error: 'body must include `def` (workflow object) or `yaml` (string)' };
  }

  if (!parsed.ok) {
    // Yaml-path parse failure → invalid row.
    const slug = input.expectedSlug ?? '';
    return {
      yaml: yamlText,
      yamlHash: sha256(yamlText),
      parsedDefinition: null,
      status: 'invalid',
      parseError: parsed.errors.join('; '),
      slug,
      name: slug,
      description: null,
      disabled: false,
    };
  }

  const wf = parsed.workflow;
  const slug = typeof wf.id === 'string' ? wf.id : '';
  if (input.expectedSlug && slug && slug !== input.expectedSlug) {
    return {
      error: `def.id "${slug}" does not match the workflow's slug "${input.expectedSlug}" — renames are not supported in place; duplicate + delete instead`,
    };
  }
  return {
    yaml: yamlText,
    yamlHash: sha256(yamlText),
    parsedDefinition: wf,
    status: 'active',
    parseError: null,
    slug: input.expectedSlug ?? slug,
    name: typeof wf.name === 'string' && wf.name ? wf.name : slug,
    description: typeof wf.description === 'string' && wf.description ? wf.description : null,
    disabled: wf.disabled === true,
  };
}

/** Slice 015b — durably record a `workflow.definition.changed` fact on the
 *  slice-002 `live_outbox` inside its own txn. The slice-015a relay drains the
 *  committed row and fans the canonical frame to subscribed sockets (global
 *  rows carry projectId:null and fan to all projects); the web hook refetches on
 *  the relay frame. This is the ONLY delivery path — the old hand-fanned frame +
 *  `workflow-changed` envelope are deleted. */
function emitDefinitionFact(row: WorkflowRow, change: WorkflowDefinitionChange): void {
  const scope = row.scope === 'global' ? 'global' : 'project';
  const projectId = scope === 'global' ? null : row.projectId;
  const definition = toWorkflowDefinitionDto({
    id: row.id,
    slug: row.slug,
    scope,
    projectId,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    status: row.status === 'invalid' ? 'invalid' : 'active',
    disabled: row.disabled,
    yamlHash: row.yamlHash,
    updatedAt: row.updatedAt,
  });
  getDb().transaction((tx) =>
    insertLiveEvent(tx, {
      scope,
      projectId,
      type: 'workflow.definition.changed',
      entity: 'workflow-definition',
      entityId: row.id,
      version: null,
      payload:
        change === 'deleted' ? { change, workflowId: row.id } : { change, definition },
    }),
  );
}

function emitChanged(row: WorkflowRow, change: WorkflowMutationKind): void {
  emitDefinitionFact(row, change);
}

/** Verify that every `agent` node in `def` references a live project-scoped
 *  pod in `projectId`. Returns one error string per offending node; empty
 *  when all pods are present. Pure policy check — no DB side-effects. */
function validateAgentNodesProjectScoped(
  def: WorkflowV2.Workflow,
  projectId: ULID,
): string[] {
  const nodes = Array.isArray((def as unknown as { nodes?: unknown }).nodes)
    ? ((def as unknown as { nodes: Record<string, unknown>[] }).nodes)
    : [];
  const errors: string[] = [];
  for (const node of nodes) {
    if (node.kind !== 'agent') continue;
    const agentName = typeof node.agent === 'string' ? node.agent : '';
    if (!agentName) continue;
    const row = getAgentByName({ name: agentName, scope: 'project', projectId });
    if (!row) {
      errors.push(
        `agent node "${String(node.id ?? '?')}": pod "${agentName}" is not a project-scoped pod in this project — clone it into the project first`,
      );
    }
  }
  return errors;
}

/** Register every workflow route on `app`. Idempotent — call once per Hono
 *  instance. */
export function registerWorkflowRoutes(app: Hono, deps: WorkflowRoutesDeps): void {
  // ---- list / get -------------------------------------------------------

  /** List live workflows. Without `?projectId`: globals only. With
   *  `?projectId=<ulid>`: union of globals + that project's project-scope
   *  rows (the rail view). Soft-deleted rows are excluded. */
  app.get('/api/workflows', (c) => {
    const qs = new URL(c.req.url).searchParams;
    const projectIdRaw = qs.get('projectId');
    const projectId = projectIdRaw ? (projectIdRaw as ULID) : undefined;
    const rows = projectId
      ? workflowsRepo.listWorkflows({ projectId, includeGlobals: true })
      : workflowsRepo.listWorkflows({ scope: 'global' });
    return c.json({ ok: true, workflows: rows });
  });

  /** Full row for the detail pane. Returns 404 when soft-deleted (use
   *  GET `/api/workflows/:id?includeDeleted=1` to read archived rows). */
  app.get('/api/workflows/:id', (c) => {
    const id = c.req.param('id') as ULID;
    const qs = new URL(c.req.url).searchParams;
    const includeDeleted = qs.get('includeDeleted') === '1';
    const row = includeDeleted
      ? workflowsRepo.getWorkflowByIdIncludingDeleted(id)
      : workflowsRepo.getWorkflowById(id);
    if (!row) return c.json({ ok: false, error: `unknown workflow: ${id}` }, 404);
    return c.json({ ok: true, workflow: row });
  });

  /** Audit log for a workflow. Filters: actor, field, beforeCreatedAt,
   *  limit. Same shape as `/api/agents/pods/:id/audit`. */
  app.get('/api/workflows/:id/audit', (c) => {
    const id = c.req.param('id') as ULID;
    if (!workflowsRepo.getWorkflowByIdIncludingDeleted(id)) {
      return c.json({ ok: false, error: `unknown workflow: ${id}` }, 404);
    }
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
      const rows = listWorkflowAudit({
        workflowId: id,
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

  // ---- create / update --------------------------------------------------

  /** Create a workflow. Body: `def` OR `yaml`, plus `projectId` (required
   *  when `scope='project'`, default), `scope?`, optional `displayName`. */
  app.post('/api/workflows', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }
    const scope: PodScope = body.scope === 'global' ? 'global' : 'project';
    let projectId: ULID | null = null;
    if (scope === 'project') {
      if (typeof body.projectId !== 'string' || !body.projectId) {
        return c.json(
          { ok: false, error: 'projectId required when scope="project"' },
          400,
        );
      }
      projectId = body.projectId as ULID;
    }
    const normalised = normaliseDef({ def: body.def, yaml: body.yaml });
    if ('error' in normalised) {
      return c.json({ ok: false, error: normalised.error }, 400);
    }
    if (!normalised.slug) {
      return c.json({ ok: false, error: 'def.id (workflow slug) required' }, 400);
    }

    // Cross-workflow stage-collision check at publish time.
    // New workflow not in DB yet → no slug exclusion needed.
    if (projectId && normalised.status === 'active' && normalised.parsedDefinition !== null) {
      const stageOnEntryWorkflows: Array<{ workflowId: string; name: string; stage: string }> = [];
      for (const r of workflowsRepo.listWorkflows({ projectId })) {
        if (r.status !== 'active' || r.disabled) continue;
        const def = r.parsedDefinition as WorkflowV2.Workflow | null;
        if (!def) continue;
        for (const t of (def.triggers ?? [])) {
          if (t.kind === 'stage-on-entry' && typeof (t as { stage?: unknown }).stage === 'string' && (t as { stage: string }).stage) {
            stageOnEntryWorkflows.push({ workflowId: r.slug, name: r.name, stage: (t as { stage: string }).stage });
          }
        }
      }
      if (stageOnEntryWorkflows.length > 0) {
        const crossResult = validateWorkflowV2(normalised.parsedDefinition, { stageOnEntryWorkflows });
        if (!crossResult.ok) {
          normalised.status = 'invalid';
          normalised.parseError = crossResult.errors.join('; ');
          normalised.parsedDefinition = null;
        }
      }
    }

    // Pod-scope enforcement: for project workflows every agent node must
    // reference a project-scoped pod. Reject publish if any pod is missing.
    if (scope === 'project' && projectId && normalised.status === 'active' && normalised.parsedDefinition !== null) {
      const podErrors = validateAgentNodesProjectScoped(normalised.parsedDefinition, projectId);
      if (podErrors.length > 0) {
        return c.json({ ok: false, error: `workflow has unresolvable pods: ${podErrors.join('; ')}` }, 400);
      }
    }

    // Per-scope slug + name uniqueness — return 409 instead of a raw UNIQUE
    // violation so callers can surface a clean message.
    const slugCollision = workflowsRepo.getWorkflowBySlug({
      slug: normalised.slug,
      scope,
      projectId,
    });
    if (slugCollision) {
      return c.json(
        {
          ok: false,
          error: `a workflow with slug "${normalised.slug}" already exists in this ${scope}`,
        },
        409,
      );
    }
    const nameCollision = workflowsRepo.getWorkflowByName({
      name: normalised.name,
      scope,
      projectId,
    });
    if (nameCollision) {
      return c.json(
        {
          ok: false,
          error: `a workflow named "${normalised.name}" already exists in this ${scope}`,
        },
        409,
      );
    }

    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim()
        ? body.displayName.trim()
        : null;
    let row: WorkflowRow;
    try {
      row = workflowsRepo.createWorkflow(
        {
          slug: normalised.slug,
          scope,
          ...(projectId ? { projectId } : {}),
          name: normalised.name,
          displayName,
          description: normalised.description,
          yaml: normalised.yaml,
          yamlHash: normalised.yamlHash,
          parsedDefinition: normalised.parsedDefinition,
          status: normalised.status,
          parseError: normalised.parseError,
          disabled: normalised.disabled,
        },
        auditFromBody(body, 'user', 'ui-create'),
      );
    } catch (err) {
      const msg = (err as Error).message;
      const status = /required|invalid|UNIQUE/i.test(msg) ? 400 : 500;
      return c.json({ ok: false, error: msg }, status);
    }
    emitChanged(row, 'created');
    return c.json({ ok: true, workflow: row }, 201);
  });

  /** Patch a workflow's body + metadata. Body accepts `def` OR `yaml` (or
   *  neither, when only `displayName` / `disabled` change). Slug is
   *  immutable in place — renaming is duplicate + delete. */
  app.put('/api/workflows/:id', async (c) => {
    const id = c.req.param('id') as ULID;
    const existing = workflowsRepo.getWorkflowById(id);
    if (!existing) return c.json({ ok: false, error: `unknown workflow: ${id}` }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400);
    }

    const patch: Parameters<typeof workflowsRepo.updateWorkflow>[1] = {};
    const hasDef = body.def && typeof body.def === 'object';
    const hasYaml = typeof body.yaml === 'string';
    if (hasDef || hasYaml) {
      const normalised = normaliseDef({
        ...(hasDef ? { def: body.def } : {}),
        ...(hasYaml ? { yaml: body.yaml } : {}),
        expectedSlug: existing.slug,
      });
      if ('error' in normalised) {
        return c.json({ ok: false, error: normalised.error }, 400);
      }

      // Cross-workflow stage-collision check at publish time. Excludes self by slug.
      const checkProjectId = existing.projectId;
      if (checkProjectId && normalised.status === 'active' && normalised.parsedDefinition !== null) {
        const stageOnEntryWorkflows: Array<{ workflowId: string; name: string; stage: string }> = [];
        for (const r of workflowsRepo.listWorkflows({ projectId: checkProjectId })) {
          if (r.status !== 'active' || r.disabled || r.slug === existing.slug) continue;
          const def = r.parsedDefinition as WorkflowV2.Workflow | null;
          if (!def) continue;
          for (const t of (def.triggers ?? [])) {
            if (t.kind === 'stage-on-entry' && typeof (t as { stage?: unknown }).stage === 'string' && (t as { stage: string }).stage) {
              stageOnEntryWorkflows.push({ workflowId: r.slug, name: r.name, stage: (t as { stage: string }).stage });
            }
          }
        }
        if (stageOnEntryWorkflows.length > 0) {
          const crossResult = validateWorkflowV2(normalised.parsedDefinition, { stageOnEntryWorkflows });
          if (!crossResult.ok) {
            normalised.status = 'invalid';
            normalised.parseError = crossResult.errors.join('; ');
            normalised.parsedDefinition = null;
          }
        }
      }

      // Pod-scope enforcement on update: same rule as on create.
      if (existing.scope === 'project' && existing.projectId && normalised.status === 'active' && normalised.parsedDefinition !== null) {
        const podErrors = validateAgentNodesProjectScoped(normalised.parsedDefinition, existing.projectId);
        if (podErrors.length > 0) {
          return c.json({ ok: false, error: `workflow has unresolvable pods: ${podErrors.join('; ')}` }, 400);
        }
      }

      patch.yaml = normalised.yaml;
      patch.yamlHash = normalised.yamlHash;
      patch.parsedDefinition = normalised.parsedDefinition;
      patch.status = normalised.status;
      patch.parseError = normalised.parseError;
      if (normalised.name && normalised.status === 'active') patch.name = normalised.name;
      if (normalised.status === 'active') patch.description = normalised.description;
      // disabled lifts out of YAML; bodies' `disabled` wins below.
      if (typeof body.disabled !== 'boolean') patch.disabled = normalised.disabled;
    }
    if (typeof body.displayName === 'string') {
      patch.displayName = body.displayName.trim() ? body.displayName.trim() : null;
    } else if (body.displayName === null) {
      patch.displayName = null;
    }
    if (typeof body.disabled === 'boolean') patch.disabled = body.disabled;
    if (typeof body.name === 'string' && body.name.trim()) {
      // Explicit rename (display name only — slug is locked).
      const next = body.name.trim();
      if (next !== existing.name) {
        const collision = workflowsRepo.getWorkflowByName({
          name: next,
          scope: existing.scope,
          projectId: existing.projectId,
        });
        if (collision && collision.id !== id) {
          return c.json(
            {
              ok: false,
              error: `a workflow named "${next}" already exists in this ${existing.scope}`,
            },
            409,
          );
        }
        patch.name = next;
      }
    }

    let updated: WorkflowRow | null;
    try {
      updated = workflowsRepo.updateWorkflow(id, patch, auditFromBody(body, 'user', 'ui-edit'));
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
    if (!updated) return c.json({ ok: false, error: `unknown workflow: ${id}` }, 404);
    emitChanged(updated, 'updated');
    return c.json({ ok: true, workflow: updated });
  });

  // ---- delete -----------------------------------------------------------

  /** Soft-delete a workflow. 409 when in-flight runs exist unless the caller
   *  passes `?cancel=1` (drives `deps.cancelInFlightRuns` first). Stock
   *  origin is reserved for forward compat; v1 has no stock workflows. */
  app.delete('/api/workflows/:id', async (c) => {
    const id = c.req.param('id') as ULID;
    const existing = workflowsRepo.getWorkflowById(id);
    if (!existing) return c.json({ ok: false, error: `unknown workflow: ${id}` }, 404);
    const qs = new URL(c.req.url).searchParams;
    const cancel = qs.get('cancel') === '1';

    // In-flight guard. Only meaningful for project-scope rows — globals
    // don't carry a project to filter runs on; their slugs may collide
    // across projects so the check is per-project anyway.
    if (existing.projectId) {
      const inFlight = deps.countInFlightRuns(existing.projectId, existing.slug);
      if (inFlight > 0 && !cancel) {
        return c.json(
          {
            ok: false,
            error: `cannot delete: ${inFlight} in-flight run(s). Pass ?cancel=1 to cancel-and-delete.`,
            kind: 'in-flight-runs' as const,
            inFlight,
          },
          409,
        );
      }
      if (inFlight > 0 && cancel && deps.cancelInFlightRuns) {
        try {
          await deps.cancelInFlightRuns(existing.projectId, existing.slug);
        } catch (err) {
          return c.json(
            { ok: false, error: `cancel failed: ${(err as Error).message}` },
            500,
          );
        }
      }
    }

    const deleted = workflowsRepo.softDeleteWorkflow(
      id,
      auditFromQuery(qs, 'user', 'ui-delete'),
    );
    if (!deleted) return c.json({ ok: false, error: `unknown workflow: ${id}` }, 404);
    emitChanged(deleted, 'deleted');
    return c.json({ ok: true });
  });

  // ---- promote-to-global / duplicate -----------------------------------

  /** Flip a project-scope row to global. 409 on global name / slug
   *  collision. Mirrors pods' promote-to-global. */
  app.post('/api/workflows/:id/promote-to-global', async (c) => {
    const id = c.req.param('id') as ULID;
    const existing = workflowsRepo.getWorkflowById(id);
    if (!existing) return c.json({ ok: false, error: `unknown workflow: ${id}` }, 404);
    if (existing.scope === 'global') {
      return c.json({ ok: false, error: 'workflow is already global' }, 400);
    }

    // Pre-check before relying on UNIQUE — surfaces a friendlier message
    // than the raw error.
    const slugCollision = workflowsRepo.getWorkflowBySlug({
      slug: existing.slug,
      scope: 'global',
    });
    if (slugCollision) {
      return c.json(
        {
          ok: false,
          error: `a global workflow with slug "${existing.slug}" already exists`,
        },
        409,
      );
    }
    const nameCollision = workflowsRepo.getWorkflowByName({
      name: existing.name,
      scope: 'global',
    });
    if (nameCollision) {
      return c.json(
        { ok: false, error: `a global workflow named "${existing.name}" already exists` },
        409,
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      /* empty body OK */
    }
    let row: WorkflowRow | null;
    try {
      row = workflowsRepo.promoteWorkflowToGlobal(
        id,
        auditFromBody(body, 'user', 'ui-promote'),
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (/UNIQUE/i.test(msg)) {
        return c.json(
          { ok: false, error: 'global slug or name collision (UNIQUE)' },
          409,
        );
      }
      return c.json({ ok: false, error: msg }, 400);
    }
    if (!row) return c.json({ ok: false, error: `unknown workflow: ${id}` }, 404);
    // Promote moves the row from per-project visibility to global. Door it:
    // a `deleted` fact to the source project (the old project-scoped row drops
    // from that project's rail) + a `created` fact on the now-global row (fans
    // to all projects). The relay delivers both; the web hook refetches.
    if (existing.projectId) emitDefinitionFact(existing, 'deleted');
    emitChanged(row, 'created');
    return c.json({ ok: true, workflow: row });
  });

  /** Force-disabled clone in the same scope. Body: `{ newName?, newSlug?,
   *  targetProjectId?, targetScope?, actor?, reason? }`. */
  app.post('/api/workflows/:id/duplicate', async (c) => {
    const sourceId = c.req.param('id') as ULID;
    const source = workflowsRepo.getWorkflowById(sourceId);
    if (!source) {
      return c.json({ ok: false, error: `unknown workflow: ${sourceId}` }, 404);
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      /* empty body OK */
    }
    const targetScope: PodScope =
      body.targetScope === 'global' ? 'global' : body.targetScope === 'project' ? 'project' : source.scope;
    let targetProjectId: ULID | null | undefined;
    if (body.targetProjectId === null) {
      targetProjectId = null;
    } else if (typeof body.targetProjectId === 'string' && body.targetProjectId) {
      targetProjectId = body.targetProjectId as ULID;
    }
    let row: WorkflowRow;
    try {
      row = workflowsRepo.duplicateWorkflow(
        {
          sourceId,
          ...(typeof body.newSlug === 'string' && body.newSlug.trim()
            ? { newSlug: body.newSlug.trim() }
            : {}),
          ...(typeof body.newName === 'string' && body.newName.trim()
            ? { newName: body.newName.trim() }
            : {}),
          ...(targetProjectId !== undefined ? { targetProjectId } : {}),
          targetScope,
        },
        auditFromBody(body, 'user', 'ui-duplicate'),
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (/already exists/i.test(msg)) {
        return c.json({ ok: false, error: msg }, 409);
      }
      return c.json({ ok: false, error: msg }, 400);
    }
    emitChanged(row, 'created');
    return c.json({ ok: true, workflow: row }, 201);
  });

  // ---- fire -------------------------------------------------------------

  /** Fire a workflow by DB id. Resolves the row, reads its
   *  `parsedDefinition`, and dispatches through the runtime's v2 executor.
   *  Replaces the legacy `POST /api/projects/:projectId/workflow-v2/fire`
   *  endpoint (which took the def inline). Trigger defaults to manual.
   *
   *  Body: `{ trigger?: { kind: 'manual' | 'stage-on-entry' | 'schedule' |
   *  'event', ... }, projectId?: ULID }`. `projectId` only consulted for
   *  global rows — project-scope rows fire in their owning project. */
  app.post('/api/workflows/:id/fire', async (c) => {
    const id = c.req.param('id') as ULID;
    const row = workflowsRepo.getWorkflowById(id);
    if (!row) return c.json({ ok: false, error: `unknown workflow: ${id}` }, 404);
    if (row.status !== 'active' || row.parsedDefinition === null) {
      return c.json(
        { ok: false, error: `workflow ${row.slug} is not active (status=${row.status})` },
        400,
      );
    }
    if (row.disabled) {
      return c.json({ ok: false, error: `workflow ${row.slug} is disabled` }, 400);
    }
    const body = await c.req.json<{ trigger?: unknown; projectId?: unknown }>().catch(
      () => ({}) as { trigger?: unknown; projectId?: unknown },
    );

    let projectId: ULID | null = row.projectId;
    if (row.scope === 'global') {
      if (typeof body.projectId !== 'string' || !body.projectId) {
        return c.json(
          {
            ok: false,
            error: 'projectId is required when firing a global workflow',
          },
          400,
        );
      }
      projectId = body.projectId as ULID;
    }
    if (!projectId) {
      return c.json(
        { ok: false, error: 'projectId could not be resolved for this workflow' },
        400,
      );
    }

    const trigger =
      body.trigger && typeof body.trigger === 'object'
        ? (body.trigger as WorkflowV2.WorkflowTrigger)
        : ({ kind: 'manual' } as WorkflowV2.WorkflowTrigger);

    // Pod-scope enforcement at fire time (last-mile guard). Even if the
    // workflow was published before enforcement was added, firing it with
    // unresolvable pods would produce confusing runtime failures — surface a
    // clear error here instead.
    {
      const def = row.parsedDefinition as WorkflowV2.Workflow;
      const podErrors = validateAgentNodesProjectScoped(def, projectId);
      if (podErrors.length > 0) {
        return c.json({ ok: false, error: `workflow cannot be fired: ${podErrors.join('; ')}` }, 400);
      }
    }

    try {
      const def = row.parsedDefinition as WorkflowV2.Workflow;
      const res = await deps.fireWorkflow(projectId, def, trigger);
      return c.json({ ok: true, ...res });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });
}
