import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Hono } from 'hono';
import type { Project, ULID as DomainULID } from '@pc/domain';
import {
  getProjectById,
  listOpenPendingAsksForProject,
  listProjects,
  listUserInboxRecipientsAllProjects,
  updateProjectNotes,
  workflowRunsV2Repo,
} from '@pc/db';
import type {
  ProjectChangedLiveEvent,
  ProjectChangedRefetchEnvelope,
  ProjectDto,
} from '@pc/contracts';
import {
  isActionableMailboxKind,
  parseCreateProjectRequest,
  parseReorderProjectsRequest,
  parseUpdateProjectRequest,
} from '@pc/contracts';
import { ProjectService } from '@pc/app-services';
import type {
  ProjectCreateFlowResult,
} from '@pc/app-services';
import type { CreateProjectFlowInput } from '../../services/project-create.ts';

export interface ProjectRoutesRuntime {
  project: { id: DomainULID };
}

export interface ProjectRoutesDeps {
  createProject(input: CreateProjectFlowInput): Promise<ProjectCreateFlowResult>;
  refreshProject(project: ProjectDto): void;
  removeProject(projectId: DomainULID): void;
  resolveProject(projectId: string): ProjectRoutesRuntime | null;
  revealProjectFolder?(folderPath: string): void;
  publishProjectChanged?(
    legacyEvent: ProjectChangedRefetchEnvelope,
    liveEvent: ProjectChangedLiveEvent,
  ): void;
}

function findProjectIncludingDeleted(projectId: DomainULID): Project | undefined {
  return getProjectById(projectId) ?? listProjects({ includeDeleted: true }).find((p) => p.id === projectId);
}

export function revealCommand(path: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: 'explorer.exe', args: [path] };
  if (process.platform === 'darwin') return { cmd: 'open', args: [path] };
  return { cmd: 'xdg-open', args: [path] };
}

function defaultRevealProjectFolder(folderPath: string): void {
  const { cmd, args } = revealCommand(folderPath);
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

export function registerProjectRoutes(app: Hono, deps: ProjectRoutesDeps): void {
  const service = new ProjectService();

  app.get('/api/projects', (c) => {
    const includeDeleted = c.req.query('include_deleted') === '1';
    return c.json(service.listProjects({ includeDeleted }));
  });

  // ── Cross-project "waiting on you" aggregation ────────────────────────────
  // Three sources: open pending asks (paused agents), paused workflow runs
  // that are at a human-review gate, and actionable + unactioned inbox items.
  // All read-only; no auth gate (single-user app).
  app.get('/api/waiting-on-you', (c) => {
    const projects = listProjects();

    // Map: projectId → byProject entry (built below)
    const projectMap = new Map<
      string,
      {
        projectId: string;
        projectName: string;
        projectSlug: string;
        pendingAsks: Array<{
          askId: string;
          agentRunId: string;
          kind: string;
          promptBody: string;
          context: string | null;
          options: unknown;
          createdAt: number;
        }>;
        workflowReviews: Array<{
          runId: string;
          workflowName: string;
          nodeId: string;
          workItemId: string | null;
        }>;
        inboxItems: Array<{
          recipientId: string;
          messageId: string;
          kind: string;
          subject: string | null;
          payload: unknown;
          createdAt: number;
        }>;
      }
    >();

    for (const project of projects) {
      const pid = project.id as DomainULID;

      // 1. Open pending asks: agents paused waiting for an answer.
      const asks = listOpenPendingAsksForProject(pid);

      // 2. Workflow runs paused at human-review nodes.
      const allRuns = workflowRunsV2Repo.listRunsByProject(pid);
      const workflowReviews: Array<{
        runId: string;
        workflowName: string;
        nodeId: string;
        workItemId: string | null;
      }> = [];
      for (const run of allRuns) {
        if (run.status !== 'paused') continue;
        let wf: { nodes?: Array<{ id: string; kind: string; reviewer?: string }> };
        try {
          wf = JSON.parse(run.workflowYamlSnapshot) as typeof wf;
        } catch {
          continue;
        }
        if (!Array.isArray(wf.nodes)) continue;
        for (const [nodeId, nodeRec] of Object.entries(
          run.dagState.nodes as Record<string, { state: string }>,
        )) {
          if (nodeRec.state !== 'awaiting-review') continue;
          const wfNode = wf.nodes.find((n) => n.id === nodeId);
          if (!wfNode || wfNode.kind !== 'review' || wfNode.reviewer !== 'human') continue;
          workflowReviews.push({
            runId: run.id,
            workflowName: run.workflowName,
            nodeId,
            workItemId: run.workItemId,
          });
        }
      }

      if (asks.length > 0 || workflowReviews.length > 0) {
        projectMap.set(project.id, {
          projectId: project.id,
          projectName: project.name,
          projectSlug: project.slug ?? '',
          pendingAsks: asks.map((a) => ({
            askId: a.id,
            agentRunId: a.agentRunId,
            kind: a.kind,
            promptBody: a.promptBody,
            context: a.context,
            options: a.options,
            createdAt: a.createdAt,
          })),
          workflowReviews,
          inboxItems: [],
        });
      }
    }

    // 3. Actionable + unactioned inbox items across all projects.
    const inboxRows = listUserInboxRecipientsAllProjects();
    for (const { recipient, message } of inboxRows) {
      if (!isActionableMailboxKind(message.kind)) continue;
      if (recipient.actionedAt !== null || recipient.dismissedAt !== null) continue;
      const pid = message.projectId ?? '';
      if (!projectMap.has(pid)) {
        const project = projects.find((p) => p.id === pid);
        if (!project) continue; // project-less or deleted — skip
        projectMap.set(pid, {
          projectId: project.id,
          projectName: project.name,
          projectSlug: project.slug ?? '',
          pendingAsks: [],
          workflowReviews: [],
          inboxItems: [],
        });
      }
      projectMap.get(pid)!.inboxItems.push({
        recipientId: recipient.id,
        messageId: message.id,
        kind: message.kind,
        subject: message.subject,
        payload: message.payload,
        createdAt: message.createdAt,
      });
    }

    const byProject = [...projectMap.values()];
    const totalCount = byProject.reduce(
      (sum, p) => sum + p.pendingAsks.length + p.workflowReviews.length + p.inboxItems.length,
      0,
    );
    return c.json({ ok: true, totalCount, byProject });
  });

  app.patch('/api/projects/reorder', async (c) => {
    const parsed = parseReorderProjectsRequest(await c.req.json<unknown>());
    if (!parsed.ok) {
      return c.json({ ok: false, error: parsed.error }, 400);
    }
    try {
      const result = service.reorderProjects(parsed.value);
      if (!result.ok) return c.json({ ok: false, error: result.error }, 500);
      deps.publishProjectChanged?.(result.legacyEvent, result.liveEvent);
      return c.json({ ok: true, projects: result.projects });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/api/projects', async (c) => {
    const parsed = parseCreateProjectRequest(await c.req.json<unknown>());
    if (!parsed.ok) {
      return c.json({ ok: false, error: parsed.error }, 400);
    }
    try {
      const result = await service.createProject(parsed.value, deps.createProject);
      if (!result.ok) return c.json({ ok: false, error: result.error }, 500);
      deps.publishProjectChanged?.(result.legacyEvent, result.liveEvent);
      return c.json({ ok: true, project: result.project }, 201);
    } catch (err) {
      const msg = (err as Error).message;
      const is400 =
        /required$|^invalid mode|^folder is not empty|^folder is already a git repo/.test(msg);
      return c.json({ ok: false, error: msg }, is400 ? 400 : 500);
    }
  });

  app.patch('/api/projects/:projectId', async (c) => {
    const id = c.req.param('projectId') as DomainULID;
    const parsed = parseUpdateProjectRequest(await c.req.json<unknown>());
    if (!parsed.ok) {
      return c.json({ ok: false, error: parsed.error }, 400);
    }
    try {
      const result = service.updateProjectMeta(id, parsed.value);
      if (!result.ok) return c.json({ ok: false, error: result.error }, 404);
      deps.refreshProject(result.project);
      deps.publishProjectChanged?.(result.legacyEvent, result.liveEvent);
      return c.json({ ok: true, project: result.project });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.delete('/api/projects/:projectId', (c) => {
    const id = c.req.param('projectId') as DomainULID;
    const result = service.softDeleteProject(id);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 404);
    deps.removeProject(id);
    deps.publishProjectChanged?.(result.legacyEvent, result.liveEvent);
    return c.json({ ok: true, project: result.project });
  });

  app.delete('/api/projects/:projectId/files', (c) => {
    const id = c.req.param('projectId') as DomainULID;
    const project = findProjectIncludingDeleted(id);
    if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);

    deps.removeProject(id);
    const folder = project.folderPath;
    const removed: string[] = [];
    const skipped: { dir: string; reason: string }[] = [];
    for (const sub of ['.project-companion', '.claude']) {
      const target = resolve(folder, sub);
      if (!existsSync(target)) continue;
      if (sub === '.claude') {
        const marker = resolve(target, '.pc-managed');
        if (!existsSync(marker)) {
          skipped.push({
            dir: sub,
            reason: 'no .pc-managed marker — PC did not create this directory',
          });
          continue;
        }
      }
      try {
        rmSync(target, { recursive: true, force: true });
        removed.push(sub);
      } catch (err) {
        return c.json({ ok: false, error: `failed to remove ${sub}: ${(err as Error).message}` }, 500);
      }
    }
    return c.json({ ok: true, removed, skipped });
  });

  app.patch('/api/projects/:projectId/notes', async (c) => {
    const id = c.req.param('projectId') as DomainULID;
    const body = await c.req.json<unknown>();
    if (typeof (body as Record<string, unknown>).text !== 'string') {
      return c.json({ ok: false, error: 'text must be a string' }, 400);
    }
    const text = (body as Record<string, unknown>).text as string;
    const updated = updateProjectNotes(id, text);
    if (!updated) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    return c.json({ ok: true, notes: updated.notes });
  });

  app.post('/api/projects/:projectId/reveal', (c) => {
    const id = c.req.param('projectId') as DomainULID;
    const project = findProjectIncludingDeleted(id);
    if (!project) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const folder = project.folderPath;
    if (!existsSync(folder)) {
      return c.json({ ok: false, error: `folder does not exist on disk: ${folder}` }, 404);
    }
    try {
      (deps.revealProjectFolder ?? defaultRevealProjectFolder)(folder);
    } catch (err) {
      return c.json({ ok: false, error: `failed to reveal: ${(err as Error).message}` }, 500);
    }
    return c.json({ ok: true });
  });

}

export function registerProjectDetailRoute(app: Hono, deps: Pick<ProjectRoutesDeps, 'resolveProject'>): void {
  const service = new ProjectService();

  app.get('/api/projects/:projectId', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const result = service.getProject(runtime.project.id);
    if (!result.ok) return c.json({ ok: false, error: `project disappeared: ${id}` }, 404);
    return c.json(result.project);
  });
}
