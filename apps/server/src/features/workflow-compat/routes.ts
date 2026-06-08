import type { Hono } from 'hono';
import type { ULID, WorkflowV2 } from '@pc/domain';
import {
  dismissFailedRun as defaultDismissFailedRun,
  listFailedRunDismissalsForProject as defaultListFailedRunDismissalsForProject,
  workflowRunsV2Repo as defaultWorkflowRunsV2Repo,
  workflowsRepo,
} from '@pc/db';
import {
  cancelWorkflowRunCascade,
  type CancelWorkflowRunResult,
} from '../../services/workflow-run-cancel.ts';
import type { ResumeFailedRunResult } from '../../services/dag-run-service.ts';
import type { AgentHostReattachClient } from '../../services/agent-host-reattach.ts';
import type {
  ReviewDecisionResult,
  WorkflowGateDecision,
} from '../../services/review-decision-service.ts';

export interface WorkflowCompatRuntime {
  project: { id: ULID };
  listV2Workflows(): {
    valid: Array<{ workflow: WorkflowV2.Workflow }>;
    invalid: Array<{ slug: string; errors: unknown }>;
  };
  findV2WorkflowBySlug(slug: string): {
    workflow: WorkflowV2.Workflow;
    yamlText: string;
  } | null;
  /** Phase 1.2 — delegates to the unified review-decision service. */
  applyWorkflowGateDecision(
    runId: ULID,
    nodeId: string,
    decision: WorkflowGateDecision,
    instanceToken?: string,
  ): Promise<ReviewDecisionResult>;
  resumeV2Run(
    runId: ULID,
    currentDefinition: WorkflowV2.Workflow | null,
  ): Promise<ResumeFailedRunResult>;
}

export interface WorkflowCompatRouteDeps {
  resolveProject(projectId: string): WorkflowCompatRuntime | null;
  now?: () => number;
  listFailedRunDismissalsForProject?: typeof defaultListFailedRunDismissalsForProject;
  dismissFailedRun?: typeof defaultDismissFailedRun;
  workflowRunsV2Repo?: Pick<
    typeof defaultWorkflowRunsV2Repo,
    'getRunForProject' | 'listEvents' | 'listRunsByProject'
  >;
  /** Live host resolver (per request) — the cancel cascade sends host `cancel`
   *  commands for the run's in-flight child agent runs. */
  getHostConnection?: () => AgentHostReattachClient | null;
  /** Test seam — defaults to the real cascade service. */
  cancelWorkflowRun?: typeof cancelWorkflowRunCascade;
}

/** Resolve the CURRENT (live) definition for a run's workflow slug — project
 *  scope first, then global. Returns null when missing, invalid, or disabled
 *  (resume must not run a definition that can't fire). */
function resolveCurrentDefinition(
  slug: string,
  projectId: ULID,
): WorkflowV2.Workflow | null {
  const row =
    workflowsRepo.getWorkflowBySlug({ slug, scope: 'project', projectId }) ??
    workflowsRepo.getWorkflowBySlug({ slug, scope: 'global' });
  if (!row || row.status !== 'active' || row.disabled || row.parsedDefinition === null) {
    return null;
  }
  return row.parsedDefinition as WorkflowV2.Workflow;
}

export function registerWorkflowCompatRoutes(app: Hono, deps: WorkflowCompatRouteDeps): void {
  const services = {
    now: deps.now ?? Date.now,
    listFailedRunDismissalsForProject:
      deps.listFailedRunDismissalsForProject ?? defaultListFailedRunDismissalsForProject,
    dismissFailedRun: deps.dismissFailedRun ?? defaultDismissFailedRun,
    workflowRunsV2Repo: deps.workflowRunsV2Repo ?? defaultWorkflowRunsV2Repo,
  };

  app.get('/api/projects/:projectId/failed-run-dismissals', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const runIds = services.listFailedRunDismissalsForProject(id as ULID);
    return c.json({ runIds });
  });

  app.post('/api/projects/:projectId/workflow-runs/:runId/dismiss', (c) => {
    const id = c.req.param('projectId');
    const runId = c.req.param('runId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const run = services.workflowRunsV2Repo.getRunForProject(runId as never, runtime.project.id);
    if (!run) return c.json({ ok: false, error: `unknown run: ${runId}` }, 404);
    const dismissedAt = services.dismissFailedRun(runId as ULID, services.now());
    return c.json({ ok: true, dismissedAt });
  });

  app.get('/api/projects/:projectId/workflow-v2/definitions', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const state = runtime.listV2Workflows();
    return c.json({
      ok: true,
      valid: state.valid.map((e) => ({
        id: e.workflow.id,
        name: e.workflow.name,
        workflow: e.workflow,
      })),
      invalid: state.invalid.map((e) => ({ fileName: `${e.slug}.yaml`, errors: e.errors })),
    });
  });

  app.get('/api/projects/:projectId/workflow-v2/definitions/:wfId', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const entry = runtime.findV2WorkflowBySlug(c.req.param('wfId'));
    if (!entry) return c.json({ ok: false, error: 'workflow not found' }, 404);
    return c.json({ ok: true, workflow: entry.workflow, yamlText: entry.yamlText });
  });

  app.get('/api/projects/:projectId/workflow-v2/runs/:runId', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const run = services.workflowRunsV2Repo.getRunForProject(
      c.req.param('runId') as never,
      runtime.project.id,
    );
    if (!run) return c.json({ ok: false, error: 'run not found' }, 404);
    return c.json({ ok: true, run, events: services.workflowRunsV2Repo.listEvents(run.id) });
  });

  app.get('/api/projects/:projectId/workflow-v2/runs', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const runs = services.workflowRunsV2Repo.listRunsByProject(runtime.project.id);
    return c.json({ ok: true, runs });
  });

  /** T5 — seed for the ActivityPanel "Waiting on you" run-state signal.
   *  Returns every (runId, nodeId) pair where the run is paused at a human
   *  review gate.  The frozen yaml snapshot (workflowYamlSnapshot) knows the
   *  node's reviewer flavor; dagState.nodes knows which nodes are
   *  awaiting-review.  Only paused runs are checked — other statuses can never
   *  have live review gates. */
  app.get('/api/projects/:projectId/workflow-v2/pending-human-reviews', (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const runs = services.workflowRunsV2Repo.listRunsByProject(runtime.project.id);
    const reviews: Array<{ runId: string; nodeId: string }> = [];
    for (const run of runs) {
      if (run.status !== 'paused') continue;
      let wf: { nodes?: Array<{ id: string; kind: string; reviewer?: string }> };
      try {
        wf = JSON.parse(run.workflowYamlSnapshot) as typeof wf;
      } catch {
        continue;
      }
      if (!Array.isArray(wf.nodes)) continue;
      for (const [nodeId, nodeRec] of Object.entries(run.dagState.nodes as Record<string, { state: string }>)) {
        if (nodeRec.state !== 'awaiting-review') continue;
        const wfNode = wf.nodes.find((n) => n.id === nodeId);
        if (!wfNode || wfNode.kind !== 'review' || wfNode.reviewer !== 'human') continue;
        reviews.push({ runId: run.id, nodeId });
      }
    }
    return c.json({ ok: true, reviews });
  });

  app.post('/api/projects/:projectId/workflow-v2/review', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const body = await c.req.json<{
      runId?: string;
      nodeId?: string;
      decision?: string;
      notes?: string;
      instanceToken?: string;
    }>();
    if (!body.runId || !body.nodeId || (body.decision !== 'approve' && body.decision !== 'reject')) {
      return c.json({ ok: false, error: 'require { runId, nodeId, decision: approve|reject }' }, 400);
    }
    try {
      const decision: WorkflowGateDecision =
        body.decision === 'reject'
          ? { kind: 'reject', ...(body.notes ? { notes: body.notes } : {}) }
          : { kind: 'approve' };
      const instanceToken = typeof body.instanceToken === 'string' && body.instanceToken
        ? body.instanceToken
        : undefined;
      // Phase 1.2 — routes through the unified review-decision service.
      const result = await runtime.applyWorkflowGateDecision(
        body.runId as ULID,
        body.nodeId,
        decision,
        instanceToken,
      );
      if (!result.ok) {
        if (result.code === 'not-found') {
          return c.json({ ok: false, error: 'run not found', code: 'not-found' }, 404);
        }
        // Gate not awaiting review or instance token mismatch — 409 (build-plan step 5).
        return c.json(
          {
            ok: false,
            error: result.error,
            code: result.code === 'instance-mismatch' ? 'instance-mismatch' : 'already-resolved',
          },
          409,
        );
      }
      // Narrow: this handler only invokes the workflow-gate branch.
      if (result.kind !== 'workflow-gate') {
        return c.json({ ok: false, error: 'unexpected result kind' }, 500);
      }
      return c.json({ ok: true, status: result.status });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  /** M6 slice C (FD-11) — cancel a workflow run for real: gateway cancel
   *  (status + fact + `workflow_cancelled` diary line) + cascade-cancel the
   *  run's in-flight child agent runs. */
  app.post('/api/projects/:projectId/workflow-v2/runs/:runId/cancel', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const cancel = deps.cancelWorkflowRun ?? cancelWorkflowRunCascade;
    const result: CancelWorkflowRunResult = await cancel({
      projectId: runtime.project.id,
      runId: c.req.param('runId') as ULID,
      ...(deps.getHostConnection ? { getHostConnection: deps.getHostConnection } : {}),
    });
    if (!result.ok) {
      return c.json(
        { ok: false, error: result.error },
        result.code === 'not-found' ? 404 : 409,
      );
    }
    return c.json({ ok: true, status: 'cancelled', cancelledChildren: result.cancelledChildren });
  });

  /** M6 slice C (FD-11 req 2+3) — resume a FAILED run from its failed step(s).
   *  Re-freezes the CURRENT definition (the repair loop: edit the def → resume
   *  → the fix is live), compat-checked against the run's kept work. */
  app.post('/api/projects/:projectId/workflow-v2/runs/:runId/resume', async (c) => {
    const id = c.req.param('projectId');
    const runtime = deps.resolveProject(id);
    if (!runtime) return c.json({ ok: false, error: `unknown project: ${id}` }, 404);
    const runId = c.req.param('runId') as ULID;
    const run = services.workflowRunsV2Repo.getRunForProject(runId, runtime.project.id);
    if (!run) return c.json({ ok: false, error: `unknown run: ${runId}` }, 404);
    const def = resolveCurrentDefinition(run.workflowId, runtime.project.id);
    const result = await runtime.resumeV2Run(runId, def);
    if (!result.ok) {
      const code =
        result.code === 'not-found' ? 404 : result.code === 'incompatible' ? 409 : 400;
      return c.json({ ok: false, error: result.error, code: result.code }, code);
    }
    return c.json({
      ok: true,
      status: result.status,
      defChanged: result.defChanged,
      resetNodes: result.resetNodes,
    });
  });
}
