import type { Hono } from 'hono';
import type { Project, Stage, ULID, WorkItem, WorkItemType } from '@pc/domain';
import { isWorkItemType } from '@pc/domain';
import {
  countWorkItemsInStage,
  getProjectById,
  listWorkItems as dbListWorkItems,
  reassignStage,
  resolveAgentForDispatch,
  updateProjectStages,
  updateWorkItemFields as dbUpdateWorkItemFields,
} from '@pc/db';

import {
  AttachmentNotInProjectError,
  type AttachmentService,
} from '../../services/attachment.ts';
import type { MailboxEnqueuePort } from '../../services/agent-delivery.ts';
import type { FieldSchemaService } from '../../services/field-schema.ts';
import {
  AgentWorkItemInputError,
  createAgentWorkItem,
  type CreateAgentWorkItemInput,
} from '../../services/agent-work-item.ts';
import {
  approveAgentWorkItem,
  rejectAgentWorkItem,
  VerificationReviewError,
} from '../../services/agent-verification-review.ts';
import type { AgentHostReattachClient } from '../../services/agent-host-reattach.ts';
import {
  FieldValidationError,
  looksLikeUlid,
  resolveWorkItemRef,
  UnknownStageError,
  WorkItemVersionConflictError,
  type WorkItemService,
} from '../../services/work-item.ts';
import { announceWorkItemRow } from '../../services/work-item-writer.ts';
import { announceStageList } from '../../services/stage-writer.ts';

export interface WorkItemRoutesRuntime {
  project: Project;
  workItemService(): WorkItemService;
  attachmentService(): AttachmentService;
  fieldSchemaService(): FieldSchemaService;
  moveAndFireV2(args: {
    id: string;
    toStage: string;
    expectedVersion?: number;
    position?: number;
    notes?: string | null;
  }): Promise<WorkItem>;
}

export interface WorkItemRoutesDeps {
  resolveProject(projectId: string): WorkItemRoutesRuntime | null;
  broadcastTo(projectId: ULID, msg: unknown): void;
  refreshProject(project: Project): void;
  /** Mailbox enqueue port — threaded into the verification-rejection
   *  continuation dispatch. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  /** T1.1 — resolve the live HostConnection PER REQUEST (not by-value at
   *  register time) so a host respawn on a new port is picked up with no API restart. */
  getHostConnection?: () => AgentHostReattachClient | null;
}

function verificationReviewStatus(err: VerificationReviewError): 400 | 404 | 409 {
  const statusFor: Record<VerificationReviewError['cause'], 400 | 404 | 409> = {
    'wi-not-found': 404,
    'not-agent-task': 400,
    'not-awaiting-verification': 409,
    'feedback-required': 400,
    'no-assigned-run': 409,
  };
  return statusFor[err.cause] ?? 400;
}

export function registerWorkItemRoutes(app: Hono, deps: WorkItemRoutesDeps): void {
  app.get('/api/projects/:projectId/work-items', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const q = c.req.query();
    // Slice 010 — `?areaId=` filters by Area. `uncaptured` (or empty) → items
    // with no Area; a ULID → that Area's items. Runs at the repo layer.
    if (q.areaId !== undefined) {
      const areaFilter = q.areaId === '' || q.areaId === 'uncaptured' ? 'uncaptured' : (q.areaId as ULID);
      let items = dbListWorkItems(runtime.project.id, { areaId: areaFilter });
      if (q.stage !== undefined) items = items.filter((wi) => wi.stageId === q.stage);
      if (q.parentId !== undefined) {
        const wanted = q.parentId === '' ? null : (q.parentId as ULID);
        items = items.filter((wi) => (wi.parentId ?? null) === wanted);
      }
      return c.json({ workItems: items });
    }
    const hasFilters =
      q.stage !== undefined ||
      q.parentId !== undefined ||
      q.includeArchived !== undefined ||
      q.cursor !== undefined ||
      q.limit !== undefined;
    if (!hasFilters) {
      return c.json({ workItems: dbListWorkItems(runtime.project.id) });
    }
    const listOpts: {
      stage?: string;
      parentId?: ULID | null;
      includeArchived?: boolean;
      cursor?: ULID;
      limit?: number;
    } = {};
    if (q.stage !== undefined) listOpts.stage = q.stage;
    if (q.parentId !== undefined) listOpts.parentId = q.parentId === '' ? null : (q.parentId as ULID);
    if (q.includeArchived === '1') listOpts.includeArchived = true;
    if (q.cursor !== undefined) listOpts.cursor = q.cursor as ULID;
    if (q.limit !== undefined) {
      const n = Number(q.limit);
      if (Number.isFinite(n)) listOpts.limit = n;
    }
    return c.json(runtime.workItemService().list(listOpts));
  });

  app.post('/api/projects/:projectId/work-items/move', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{
      id?: string;
      toStage?: string;
      toFlag?: 'done' | 'cancelled' | 'new';
      notes?: string;
    }>();
    const wiId = typeof body.id === 'string' ? body.id.trim() : '';
    const toStage = typeof body.toStage === 'string' ? body.toStage.trim() : '';
    const toFlag = typeof body.toFlag === 'string' ? body.toFlag.trim() : '';
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
    if (!wiId) return c.json({ ok: false, error: 'id required' }, 400);
    if (!toStage && !toFlag) {
      return c.json({ ok: false, error: 'toStage or toFlag required' }, 400);
    }
    if (toStage && toFlag) {
      return c.json({ ok: false, error: 'pass exactly one of toStage / toFlag' }, 400);
    }
    let resolvedStage = toStage;
    if (toFlag) {
      if (toFlag !== 'done' && toFlag !== 'cancelled' && toFlag !== 'new') {
        return c.json({ ok: false, error: `unknown toFlag: ${toFlag}` }, 400);
      }
      const project = getProjectById(id as ULID);
      if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
      const flagKey = toFlag === 'done' ? 'isDone' : toFlag === 'cancelled' ? 'isCancelled' : 'isNew';
      const match = project.stages.find((s) => s[flagKey]);
      if (!match) {
        return c.json(
          { ok: false, error: `no stage in project carries is_${toFlag}` },
          400,
        );
      }
      resolvedStage = match.id;
    }
    try {
      const workItem = await runtime.moveAndFireV2({
        id: wiId,
        toStage: resolvedStage,
        notes: notes || null,
      });
      // Announce is fired inside moveAndFireV2 (via workItemService or
      // project-runtime's write-door); no additional broadcast here.
      return c.json({ ok: true, workItem });
    } catch (err) {
      const msg = (err as Error).message;
      const is409 = /^ambiguous trigger|^no valid workflow|is locked: workflow in progress/.test(msg);
      return c.json({ ok: false, error: msg }, is409 ? 409 : 500);
    }
  });

  app.post('/api/projects/:projectId/work-items/update', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{
      id?: string;
      fields?: Record<string, unknown>;
      body?: string;
      title?: string;
      areaId?: string | null;
    }>();
    const wiId = typeof body.id === 'string' ? body.id.trim() : '';
    const fields = body.fields && typeof body.fields === 'object' ? body.fields : null;
    const bodyText = typeof body.body === 'string' ? body.body : undefined;
    const titleText = typeof body.title === 'string' ? body.title : undefined;
    // Slice 010 — `areaId: null` is a meaningful value (move to Uncaptured), so
    // discriminate "present" via hasOwnProperty rather than a truthiness check.
    const areaIdProvided = Object.prototype.hasOwnProperty.call(body, 'areaId');
    const areaId = areaIdProvided ? (body.areaId === null ? null : (body.areaId as ULID)) : undefined;
    if (!wiId) return c.json({ ok: false, error: 'id required' }, 400);
    if (!fields && bodyText === undefined && titleText === undefined && !areaIdProvided) {
      return c.json({ ok: false, error: 'at least one of fields, body, title, or areaId required' }, 400);
    }
    try {
      if (bodyText !== undefined || titleText !== undefined || areaIdProvided) {
        const current = runtime.workItemService().get(wiId as ULID);
        if (!current) return c.json({ ok: false, error: `unknown work item: ${wiId}` }, 404);
        const patchInput: Parameters<ReturnType<typeof runtime.workItemService>['patch']>[1] = {
          expectedVersion: current.version,
        };
        if (titleText !== undefined) patchInput.title = titleText;
        if (bodyText !== undefined) patchInput.body = bodyText;
        if (fields) patchInput.fields = fields;
        if (areaId !== undefined) patchInput.areaId = areaId;
        // patch() announces internally — no separate broadcastTo call.
        const workItem = runtime.workItemService().patch(wiId as ULID, patchInput);
        return c.json({ ok: true, workItem });
      }
      const workItem = dbUpdateWorkItemFields(wiId as ULID, fields!);
      if (!workItem) return c.json({ ok: false, error: `unknown work item: ${wiId}` }, 404);
      // dbUpdateWorkItemFields bypasses the service; announce through the durable
      // door (outbox row). The relay delivers the canonical work-item.changed frame.
      announceWorkItemRow(workItem, id as ULID, 'patched');
      return c.json({ ok: true, workItem });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/api/projects/:projectId/work-items/create', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{
      title?: string;
      stageId?: string;
      body?: string;
      parentId?: string | null;
      type?: string;
      fields?: Record<string, unknown>;
      areaId?: string | null;
    }>();
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const stageId = typeof body.stageId === 'string' ? body.stageId.trim() : '';
    if (!title || !stageId) return c.json({ ok: false, error: 'title and stageId required' }, 400);
    let typeOpt: WorkItemType | undefined;
    if (body.type !== undefined) {
      if (!isWorkItemType(body.type)) {
        return c.json({ ok: false, error: `unknown work-item type: ${String(body.type)}` }, 400);
      }
      typeOpt = body.type;
    }
    try {
      const workItem = runtime.workItemService().create({
        title,
        stageId,
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId as ULID | null } : {}),
        ...(typeOpt !== undefined ? { type: typeOpt } : {}),
        ...(body.fields !== undefined ? { fields: body.fields } : {}),
        ...(body.areaId !== undefined ? { areaId: body.areaId === null ? null : (body.areaId as ULID) } : {}),
      });
      return c.json({ ok: true, workItem });
    } catch (err) {
      if (err instanceof FieldValidationError) {
        return c.json({ ok: false, error: err.message, errors: err.errors }, 400);
      }
      if (err instanceof UnknownStageError) {
        return c.json({ ok: false, error: err.message }, 400);
      }
      const msg = (err as Error).message;
      const is400 = /^unknown stage:|^title required$/.test(msg);
      return c.json({ ok: false, error: msg }, is400 ? 400 : 500);
    }
  });

  app.post('/api/projects/:projectId/work-items/create-agent-contract', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{
      title?: string;
      task?: string;
      pod?: string;
      expected_output?: unknown;
      verification_tier?: unknown;
      parent_work_item_id?: string | null;
      stage_id?: string;
      worktree?: string | null;
      ephemeral?: boolean;
      raw_acceptance_criteria?: unknown;
    }>();
    const input: CreateAgentWorkItemInput = {
      title: typeof body.title === 'string' ? body.title : '',
      task: typeof body.task === 'string' ? body.task : '',
      pod: typeof body.pod === 'string' ? body.pod : '',
      ...(body.expected_output !== undefined
        ? { expectedOutput: body.expected_output as CreateAgentWorkItemInput['expectedOutput'] }
        : {}),
      ...(typeof body.verification_tier === 'string'
        ? {
            verificationTier:
              body.verification_tier as CreateAgentWorkItemInput['verificationTier'],
          }
        : {}),
      ...(body.parent_work_item_id !== undefined
        ? { parentWorkItemId: body.parent_work_item_id as ULID | null }
        : {}),
      ...(typeof body.stage_id === 'string' ? { stageId: body.stage_id } : {}),
      ...(body.worktree !== undefined ? { worktree: body.worktree } : {}),
      ...(typeof body.ephemeral === 'boolean' ? { ephemeral: body.ephemeral } : {}),
      ...(body.raw_acceptance_criteria !== undefined
        ? {
            rawAcceptanceCriteria:
              body.raw_acceptance_criteria as CreateAgentWorkItemInput['rawAcceptanceCriteria'],
          }
        : {}),
    };
    try {
      const workItem = createAgentWorkItem(input, {
        workItemService: runtime.workItemService(),
        getProject: () => runtime.project,
        getPodRowExpectedOutput: (podName) => {
          const row = resolveAgentForDispatch(podName, runtime.project.id);
          return row?.expectedOutput ?? null;
        },
      });
      return c.json({ ok: true, workItem });
    } catch (err) {
      if (err instanceof AgentWorkItemInputError) {
        return c.json({ ok: false, error: err.message }, 400);
      }
      if (err instanceof FieldValidationError) {
        return c.json({ ok: false, error: err.message, errors: err.errors }, 400);
      }
      if (err instanceof UnknownStageError) {
        return c.json({ ok: false, error: err.message }, 400);
      }
      const msg = (err as Error).message;
      const is400 = /^unknown stage:|^title required$/.test(msg);
      return c.json({ ok: false, error: msg }, is400 ? 400 : 500);
    }
  });

  app.post('/api/projects/:projectId/work-items/:wiId/approve', async (c) => {
    const id = c.req.param('projectId');
    const wiId = c.req.param('wiId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{ notes?: string | null; actor?: 'orchestrator' | 'user' }>().catch(
      () => ({}) as { notes?: string | null; actor?: 'orchestrator' | 'user' },
    );
    try {
      const project = getProjectById(id as ULID);
      const workItem = approveAgentWorkItem({
        workItemId: wiId,
        notes: typeof body.notes === 'string' ? body.notes : null,
        ...(body.actor === 'orchestrator' || body.actor === 'user' ? { actor: body.actor } : {}),
        ...(project ? { project } : {}),
      });
      if (workItem.projectId !== id) {
        return c.json({ ok: false, error: `unknown work item: ${wiId}` }, 404);
      }
      return c.json({ ok: true, workItem });
    } catch (err) {
      if (err instanceof VerificationReviewError) {
        return c.json(
          { ok: false, error: err.message, cause: err.cause },
          verificationReviewStatus(err),
        );
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/api/projects/:projectId/work-items/:wiId/reject', async (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const wiId = c.req.param('wiId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
    const body = await c.req.json<{
      feedback?: string;
      actor?: 'orchestrator' | 'user';
      dispatcherSessionId?: string;
    }>();
    const dispatcherSessionId =
      typeof body.dispatcherSessionId === 'string' ? body.dispatcherSessionId.trim() : '';
    if (!dispatcherSessionId) {
      return c.json(
        { ok: false, error: 'dispatcherSessionId required (orchestrator must forward PC_SESSION_ID)' },
        400,
      );
    }
    const host = deps.getHostConnection?.() ?? null;
    try {
      const result = await rejectAgentWorkItem(
        {
          workItemId: wiId,
          feedback: typeof body.feedback === 'string' ? body.feedback : '',
          ...(body.actor === 'orchestrator' || body.actor === 'user' ? { actor: body.actor } : {}),
          dispatcherSessionId,
          project,
        },
        {
          ...(deps.mailboxEnqueue ? { mailboxEnqueue: deps.mailboxEnqueue } : {}),
          broadcast: (env) => deps.broadcastTo(projectId, env),
          ...(host ? { hostClient: host } : {}),
        },
      );
      if (result.workItem.projectId !== projectId) {
        return c.json({ ok: false, error: `unknown work item: ${wiId}` }, 404);
      }
      return c.json({
        ok: true,
        workItem: result.workItem,
        continuation: result.continuation,
      });
    } catch (err) {
      if (err instanceof VerificationReviewError) {
        return c.json(
          { ok: false, error: err.message, cause: err.cause },
          verificationReviewStatus(err),
        );
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/projects/:projectId/work-items/:wiId', (c) => {
    const id = c.req.param('projectId') as ULID;
    const ref = c.req.param('wiId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const includeArchived = c.req.query('includeArchived') === '1';
    const resolved = resolveWorkItemRef(id, ref);
    if (resolved) {
      if (includeArchived || resolved.deletedAt == null) {
        return c.json({ ok: true, workItem: resolved });
      }
    }
    if (includeArchived && looksLikeUlid(ref)) {
      const archived = runtime.workItemService().get(ref as ULID, { includeArchived: true });
      if (archived && archived.projectId === id) {
        return c.json({ ok: true, workItem: archived });
      }
    }
    return c.json({ ok: false, error: `unknown work item: ${ref}` }, 404);
  });

  app.patch('/api/projects/:projectId/work-items/:wiId', async (c) => {
    const id = c.req.param('projectId');
    const wiId = c.req.param('wiId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{
      version?: number;
      title?: string;
      body?: string;
      stageId?: string;
      parentId?: string | null;
      position?: number;
      type?: string;
      fields?: Record<string, unknown>;
      areaId?: string | null;
    }>();
    if (typeof body.version !== 'number') {
      return c.json({ ok: false, error: 'version required' }, 400);
    }
    if (body.type !== undefined && !isWorkItemType(body.type)) {
      return c.json({ ok: false, error: `unknown work-item type: ${String(body.type)}` }, 400);
    }
    try {
      const input: Parameters<ReturnType<typeof runtime.workItemService>['patch']>[1] = {
        expectedVersion: body.version,
      };
      if (body.title !== undefined) input.title = body.title;
      if (body.body !== undefined) input.body = body.body;
      if (body.stageId !== undefined) input.stageId = body.stageId;
      if (body.parentId !== undefined) input.parentId = body.parentId as ULID | null;
      if (body.position !== undefined) input.position = body.position;
      if (body.type !== undefined) input.type = body.type as WorkItemType;
      if (body.fields !== undefined) input.fields = body.fields;
      if (body.areaId !== undefined) input.areaId = body.areaId === null ? null : (body.areaId as ULID);
      const workItem = runtime.workItemService().patch(wiId, input);
      return c.json({ ok: true, workItem });
    } catch (err) {
      if (err instanceof WorkItemVersionConflictError) {
        return c.json({ ok: false, error: err.message, current: err.current }, 409);
      }
      if (err instanceof FieldValidationError) {
        return c.json({ ok: false, error: err.message, errors: err.errors }, 400);
      }
      if (err instanceof UnknownStageError) {
        return c.json({ ok: false, error: err.message }, 400);
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/api/projects/:projectId/work-items/:wiId/move', async (c) => {
    const id = c.req.param('projectId');
    const wiId = c.req.param('wiId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{ version?: number; stageId?: string; position?: number }>();
    if (typeof body.version !== 'number') {
      return c.json({ ok: false, error: 'version required' }, 400);
    }
    const stageId = typeof body.stageId === 'string' ? body.stageId.trim() : '';
    if (!stageId) return c.json({ ok: false, error: 'stageId required' }, 400);
    try {
      const moveArgs: Parameters<typeof runtime.moveAndFireV2>[0] = {
        id: wiId,
        toStage: stageId,
        expectedVersion: body.version,
      };
      if (body.position !== undefined) moveArgs.position = body.position;
      const workItem = await runtime.moveAndFireV2(moveArgs);
      return c.json({ ok: true, workItem });
    } catch (err) {
      if (err instanceof WorkItemVersionConflictError) {
        return c.json({ ok: false, error: err.message, current: err.current }, 409);
      }
      if (err instanceof UnknownStageError) {
        return c.json({ ok: false, error: err.message }, 400);
      }
      const msg = (err as Error).message;
      const is409 = /^ambiguous trigger|^no valid workflow|is locked: workflow in progress/.test(msg);
      return c.json({ ok: false, error: msg }, is409 ? 409 : 500);
    }
  });

  app.delete('/api/projects/:projectId/work-items/:wiId', (c) => {
    const id = c.req.param('projectId');
    const wiId = c.req.param('wiId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    try {
      runtime.workItemService().softDelete(wiId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 404);
    }
  });

  app.post('/api/projects/:projectId/work-items/:wiId/restore', (c) => {
    const id = c.req.param('projectId');
    const wiId = c.req.param('wiId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    try {
      const workItem = runtime.workItemService().restore(wiId);
      return c.json({ ok: true, workItem });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 404);
    }
  });

  app.get('/api/projects/:projectId/work-items/:wiId/attachments', (c) => {
    const id = c.req.param('projectId');
    const wiId = c.req.param('wiId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    try {
      return c.json({ ok: true, items: runtime.attachmentService().list(wiId) });
    } catch (err) {
      if (err instanceof AttachmentNotInProjectError) {
        return c.json({ ok: false, error: err.message }, 404);
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/projects/:projectId/work-items/:wiId/attachments/:aId', (c) => {
    const id = c.req.param('projectId');
    const aId = c.req.param('aId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    try {
      return c.json({ ok: true, attachment: runtime.attachmentService().get(aId) });
    } catch (err) {
      if (err instanceof AttachmentNotInProjectError) {
        return c.json({ ok: false, error: err.message }, 404);
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/api/projects/:projectId/attachments/:aId', (c) => {
    const id = c.req.param('projectId');
    const aId = c.req.param('aId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    try {
      return c.json({ ok: true, attachment: runtime.attachmentService().get(aId) });
    } catch (err) {
      if (err instanceof AttachmentNotInProjectError) {
        return c.json({ ok: false, error: err.message }, 404);
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.delete('/api/projects/:projectId/work-items/:wiId/attachments/:aId', (c) => {
    const id = c.req.param('projectId');
    const aId = c.req.param('aId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    try {
      runtime.attachmentService().delete(aId);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AttachmentNotInProjectError) {
        return c.json({ ok: false, error: err.message }, 404);
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/api/projects/:projectId/work-items/:wiId/attachments', async (c) => {
    const id = c.req.param('projectId');
    const wiId = c.req.param('wiId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const payload = await c.req.json<{
      kind?: string;
      name?: string;
      content?: string;
      contentType?: string | null;
      runId?: ULID | null;
      source?: 'agent' | 'user';
      agentName?: string | null;
      nodeId?: string | null;
    }>();
    const kind = typeof payload.kind === 'string' && payload.kind.trim() ? payload.kind.trim() : 'text';
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    const content = typeof payload.content === 'string' ? payload.content : '';
    if (!name) return c.json({ ok: false, error: 'name required' }, 400);
    if (!content) return c.json({ ok: false, error: 'content required' }, 400);
    try {
      const attachment = runtime.attachmentService().create({
        workItemId: wiId,
        kind,
        name,
        content,
        contentType: payload.contentType ?? null,
        runId: payload.runId ?? null,
        source: payload.source === 'agent' ? 'agent' : 'user',
        agentName: payload.agentName ?? null,
        nodeId: payload.nodeId ?? null,
      });
      return c.json({ ok: true, attachment }, 201);
    } catch (err) {
      if (err instanceof AttachmentNotInProjectError) {
        return c.json({ ok: false, error: err.message }, 404);
      }
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.patch('/api/projects/:projectId/stages', async (c) => {
    const id = c.req.param('projectId') as ULID;
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{
      stages?: Stage[];
      force?: boolean;
      fallbackStageId?: string;
    }>();
    if (!Array.isArray(body.stages)) {
      return c.json({ ok: false, error: 'stages array required' }, 400);
    }
    const incoming: Stage[] = body.stages.map((s, idx) => ({
      id: String(s.id ?? '').trim(),
      name: String(s.name ?? '').trim(),
      order: typeof s.order === 'number' ? s.order : idx,
      ...(s.isDone === true ? { isDone: true } : {}),
      ...(s.isCancelled === true ? { isCancelled: true } : {}),
      ...(s.isNew === true ? { isNew: true } : {}),
    }));
    if (incoming.some((s) => !s.id || !s.name)) {
      return c.json({ ok: false, error: 'each stage requires id + name' }, 400);
    }
    const ids = new Set(incoming.map((s) => s.id));
    if (ids.size !== incoming.length) {
      return c.json({ ok: false, error: 'duplicate stage id' }, 400);
    }
    if (incoming.filter((s) => s.isDone).length > 1) {
      return c.json({ ok: false, error: 'at most one stage can be marked is_done' }, 400);
    }
    if (incoming.filter((s) => s.isCancelled).length > 1) {
      return c.json({ ok: false, error: 'at most one stage can be marked is_cancelled' }, 400);
    }
    if (incoming.filter((s) => s.isNew).length > 1) {
      return c.json({ ok: false, error: 'at most one stage can be marked is_new' }, 400);
    }

    const project = getProjectById(id);
    if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);

    const removed = project.stages.filter((s) => !ids.has(s.id));
    if (removed.length > 0 && body.force !== true) {
      const orphans = removed.map((s) => ({
        id: s.id,
        name: s.name,
        count: countWorkItemsInStage(id, s.id),
      }));
      const totalCount = orphans.reduce((sum, o) => sum + o.count, 0);
      if (totalCount > 0) {
        return c.json(
          {
            ok: false,
            error: 'STAGE_HAS_ITEMS',
            orphans: orphans.filter((o) => o.count > 0),
          },
          409,
        );
      }
    }

    if (removed.length > 0 && body.force === true) {
      const fallbackId = String(body.fallbackStageId ?? '').trim();
      if (!fallbackId || !ids.has(fallbackId)) {
        return c.json({ ok: false, error: 'fallbackStageId required + must reference a retained stage' }, 400);
      }
      for (const r of removed) {
        reassignStage(id, r.id, fallbackId);
      }
    }

    // updateProjectStages now returns the rev-stamped stages.
    const stamped = updateProjectStages(id, incoming);
    const updated = getProjectById(id);
    if (!updated) return c.json({ ok: false, error: 'project disappeared after stage update' }, 500);
    deps.refreshProject(updated);
    // Slice 015b — announce through the durable door (stage.list.changed outbox
    // row); the relay delivers the canonical frame. The stamped stages carry the
    // monotonic `rev` the consumer dedupes by. No hand-fanout.
    announceStageList(id, stamped);
    return c.json({ ok: true, project: updated });
  });

  app.get('/api/projects/:projectId/field-schemas', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    return c.json({ ok: true, items: runtime.fieldSchemaService().list() });
  });

  app.put('/api/projects/:projectId/field-schemas', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{ items?: unknown }>();
    if (!Array.isArray(body.items)) {
      return c.json({ ok: false, error: 'items array required' }, 400);
    }
    try {
      const items = runtime.fieldSchemaService().replace(
        body.items as Parameters<ReturnType<typeof runtime.fieldSchemaService>['replace']>[0],
      );
      return c.json({ ok: true, items });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });
}
