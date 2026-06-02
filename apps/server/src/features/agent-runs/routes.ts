import { existsSync } from 'node:fs';

import type { Hono } from 'hono';
import type {
  AgentRunStatus,
  PendingAskKind,
  PendingAskOption,
  ULID,
} from '@pc/domain';
import {
  AgentRunJsonlTailer,
  jsonlPathFor,
  type AgentRunJsonlEvent,
  type AgentRunState,
} from '@pc/runtime';
import {
  getAgentRunRow,
  getProjectById,
  listActiveAgentRunsForProject,
  listAgentRunsForSession,
  listProjectVisibleAgents,
} from '@pc/db';

import {
  dispatchContinueAgent as defaultDispatchContinueAgent,
  dispatchFreshAgent as defaultDispatchFreshAgent,
} from '../../services/agent-run-factory.ts';
import {
  answerPendingAsk as defaultAnswerPendingAsk,
  cancelPendingAsk as defaultCancelPendingAsk,
  recordExplicitPause as defaultRecordExplicitPause,
} from '../../services/pause-resume.ts';
import { getActiveRunRegistry as defaultGetActiveRunRegistry } from '../../services/agent-active-runs.ts';
import { hardKillAgentRun, inspectAgentRun } from '../../services/agent-run-control.ts';
import { recordAgentInvoke as defaultRecordAgentInvoke } from '../../services/agent-audit.ts';
import { checkInvokeDepth as defaultCheckInvokeDepth } from '../../services/invoke-depth.ts';
import type { AgentHostReattachClient } from '../../services/agent-host-reattach.ts';
import type { MailboxEnqueuePort } from '../../services/agent-delivery.ts';

interface AgentRunCancelEntry {
  projectId: ULID;
  run: { cancel(): void };
}

export interface AgentRunActiveRegistry {
  get(runId: string): AgentRunCancelEntry | null;
}

export interface AgentRunRouteDeps {
  broadcastTo(projectId: ULID, msg: unknown): void;
  /** T1.1 — resolve the live HostConnection PER REQUEST (not captured by-value
   *  at register time) so a host respawn on a new port is picked up without an
   *  API restart. */
  getHostConnection?: () => AgentHostReattachClient | null;
  /** Mailbox enqueue port; threaded into the factory/terminal/pause/kill
   *  delivery sites — the sole delivery door. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  getActiveRunRegistry?: () => AgentRunActiveRegistry;
  dispatchFreshAgent?: typeof defaultDispatchFreshAgent;
  dispatchContinueAgent?: typeof defaultDispatchContinueAgent;
  recordAgentInvoke?: typeof defaultRecordAgentInvoke;
  recordExplicitPause?: typeof defaultRecordExplicitPause;
  answerPendingAsk?: typeof defaultAnswerPendingAsk;
  cancelPendingAsk?: typeof defaultCancelPendingAsk;
  checkInvokeDepth?: typeof defaultCheckInvokeDepth;
  now?: () => number;
}

const VALID_AGENT_RUN_STATUSES: AgentRunStatus[] = [
  'queued',
  'spawning',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

function continuationFailureStatus(cause: string): number {
  const statusFor: Record<string, number> = {
    'run-not-found': 404,
    'not-continuable': 409,
    'concurrent-continuation': 409,
    'session-expired': 410,
    'project-missing': 404,
    'unknown-agent': 404,
    'pod-materialisation-failed': 500,
    'scratch-mkdir-failed': 500,
  };
  return statusFor[cause] ?? 400;
}

function loadAgentRunEvents(jsonlPath: string): AgentRunJsonlEvent[] {
  const events: AgentRunJsonlEvent[] = [];
  const tailer = new AgentRunJsonlTailer({ filePath: jsonlPath, pollIntervalMs: 60_000 });
  tailer.on('event', (event: AgentRunJsonlEvent) => events.push(event));
  tailer.drainAvailable();
  return events;
}

function transcriptStatusFor(
  jsonlPath: string,
  events: AgentRunJsonlEvent[],
): 'ready' | 'empty' | 'missing' {
  if (!existsSync(jsonlPath)) return 'missing';
  return events.length === 0 ? 'empty' : 'ready';
}

export function registerAgentRunRoutes(app: Hono, deps: AgentRunRouteDeps): void {
  const services = {
    getActiveRunRegistry: deps.getActiveRunRegistry ?? defaultGetActiveRunRegistry,
    dispatchFreshAgent: deps.dispatchFreshAgent ?? defaultDispatchFreshAgent,
    dispatchContinueAgent: deps.dispatchContinueAgent ?? defaultDispatchContinueAgent,
    recordAgentInvoke: deps.recordAgentInvoke ?? defaultRecordAgentInvoke,
    recordExplicitPause: deps.recordExplicitPause ?? defaultRecordExplicitPause,
    answerPendingAsk: deps.answerPendingAsk ?? defaultAnswerPendingAsk,
    cancelPendingAsk: deps.cancelPendingAsk ?? defaultCancelPendingAsk,
    checkInvokeDepth: deps.checkInvokeDepth ?? defaultCheckInvokeDepth,
    now: deps.now ?? Date.now,
  };

  // Resolve the mailbox port once; thread into the factory / terminal / pause /
  // kill delivery sites (the sole delivery door post-017-Phase-C).
  const mailboxEnqueue = deps.mailboxEnqueue ?? null;

  // T1.1 — resolve the live host connection PER CALL (the route no longer
  // captures it by-value at register time, which is what kept dispatch broken
  // after a host respawn until the API restarted).
  const resolveHost = (): AgentHostReattachClient | null => deps.getHostConnection?.() ?? null;

  // OBJ-2A — on-demand host level-read for the pause gate. Refreshes the host's
  // run cache (the same `list-runs` primitive the reconcile sweep uses) then
  // re-reads THIS run, so an immediate `pc_ask_user` decides from authority
  // instead of waiting up to 15s for the next sweep tick. Only meaningful when
  // a host client exists; the pause call wires it conditionally.
  const hostRunStateReader = async (id: ULID): Promise<AgentRunState | null> => {
    const hostClient = resolveHost();
    if (!hostClient) return null;
    // `list-runs` refresh + find-by-runId — the SAME primitive the reconcile
    // sweep uses (index.ts), staying on the AgentHostReattachClient interface.
    await hostClient.sendCommand({ type: 'list-runs' });
    return hostClient.listRuns().find((r) => r.runId === id)?.state ?? null;
  };

  /** Activity Panel snapshot: this project's active agent runs (queued |
   *  spawning | running | paused). Card filtering happens client-side; the
   *  panel applies subsequent `agent-run-changed` WS envelopes as deltas. */
  app.get('/api/projects/:projectId/agent-runs', (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
    const rows = listActiveAgentRunsForProject(projectId);
    const shimmed = rows.map((r) => ({
      runId: r.id,
      sessionId: r.ccSessionId,
      agentName: r.podName,
      model: 'opus',
      projectId: r.projectId,
      parentWorkItemId: r.parentWorkItemId,
      dispatcherSessionId: r.dispatcherSessionId,
      wait: false,
      worktreeDir: project.folderPath,
      startedAt: r.queuedAt,
      status: r.status,
      result: r.result ?? '',
      failureReason: r.failureReason,
      failureCause: r.failureCause,
      endedAt: r.completedAt,
      rev: r.rev,
    }));
    return c.json({ ok: true, runs: shimmed });
  });

  /** One-shot JSONL backfill for the Activity Panel transcript modal. Live
   *  events still arrive through WS as `agent-jsonl-event`; this endpoint
   *  fills the pre-open gap by replaying CC's per-session JSONL. */
  app.get('/api/projects/:projectId/agent-runs/:runId/events', (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

    const runId = c.req.param('runId') as ULID;
    const row = getAgentRunRow(runId);
    if (!row) return c.json({ ok: false, error: `unknown run: ${runId}` }, 404);
    if (row.projectId !== projectId) {
      return c.json({ ok: false, error: `run ${runId} not in project ${projectId}` }, 400);
    }

    const jsonlPath = jsonlPathFor(project.folderPath, row.ccSessionId);
    const events = loadAgentRunEvents(jsonlPath);
    return c.json({
      ok: true,
      runId: row.id,
      status: row.status,
      jsonlPath,
      transcriptStatus: transcriptStatusFor(jsonlPath, events),
      events,
    });
  });

  /** Cancel an in-flight agent run. Looks up the AgentRun via the active-runs
   *  registry; `run.cancel()` flips the state machine to `cancelled` + kills
   *  the underlying LowLevelSpawn + triggers terminal handlers. */
  app.post('/api/projects/:projectId/agent-runs/:runId/cancel', (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
    const runId = c.req.param('runId') as ULID;
    const entry = services.getActiveRunRegistry().get(runId);
    if (!entry) return c.json({ ok: false, error: `unknown run: ${runId}` }, 404);
    if (entry.projectId !== projectId) {
      return c.json({ ok: false, error: `run ${runId} not in project ${projectId}` }, 400);
    }
    entry.run.cancel();
    return c.json({ ok: true, status: 'cancelled' });
  });

  /** Hard-kill: force-end a run even when it's a PHANTOM (registry handle lost
   *  / process already dead) — the gap /cancel can't cover. Force-kills the
   *  persisted pid's process tree + finalizes the row to `cancelled` with full
   *  effects. Idempotent: already-terminal returns ok. */
  app.post('/api/projects/:projectId/agent-runs/:runId/kill', (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
    const runId = c.req.param('runId') as ULID;
    const row = getAgentRunRow(runId);
    if (!row) return c.json({ ok: false, error: `unknown run: ${runId}` }, 404);
    if (row.projectId !== projectId) {
      return c.json({ ok: false, error: `run ${runId} not in project ${projectId}` }, 400);
    }
    const result = hardKillAgentRun(runId, {
      activeRunRegistry: defaultGetActiveRunRegistry(),
      mailboxEnqueue,
      broadcast: deps.broadcastTo,
    });
    return c.json(result, result.ok ? 200 : 404);
  });

  /** Inspect / peek: status + pid liveness + idle age + last JSONL action.
   *  "Is it working or wedged?" without digging through the DB by hand. */
  app.get('/api/projects/:projectId/agent-runs/:runId/inspect', (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
    const runId = c.req.param('runId') as ULID;
    const row = getAgentRunRow(runId);
    if (!row) return c.json({ ok: false, error: `unknown run: ${runId}` }, 404);
    if (row.projectId !== projectId) {
      return c.json({ ok: false, error: `run ${runId} not in project ${projectId}` }, 400);
    }
    const result = inspectAgentRun(runId);
    return c.json(result, result.ok ? 200 : 404);
  });

  /** `pc_list_agents` HTTP surface — the orchestrator's live roster lookup.
   *  Returns the agents dispatchable inside this project: project-scope pods +
   *  built-in (stock) globals, via the shared `listProjectVisibleAgents` (same
   *  path/rule as `{{AVAILABLE_AGENTS}}` and the Agents-tab route). Global
   *  user-created pods are excluded. Shape matches the slim parser in
   *  `pc_list_agents` ({ globals: [{ name, def: { description, model, tools } }],
   *  overrides, projectOnly }); post-17e everything lives in `globals`. */
  app.get('/api/projects/:projectId/agents', (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
    const globals = listProjectVisibleAgents(projectId).map((a) => ({
      name: a.name,
      def: { description: a.description, model: a.model, tools: a.tools },
    }));
    return c.json({ ok: true, globals, overrides: [], projectOnly: [] });
  });

  /** `pc_invoke_agent` HTTP surface. Every spawn goes through the `AgentRun`
   *  wrapper. Terminal `agent-completed` / `agent-failed` envelopes flow via
   *  the hybrid delivery path. */
  app.post('/api/projects/:projectId/agents/:name/invoke', async (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

    const agentName = c.req.param('name').trim();
    if (!agentName) return c.json({ ok: false, error: 'agent name required' }, 400);

    const body = await c.req.json<{
      input?: string;
      parentWorkItemId?: ULID;
      workItemId?: ULID;
      parentInvokeDepth?: number;
      dispatcherSessionId?: string;
    }>();

    const input = typeof body.input === 'string' ? body.input : '';
    if (!input.trim()) return c.json({ ok: false, error: 'input required' }, 400);
    const parentWorkItemId =
      typeof body.parentWorkItemId === 'string' ? (body.parentWorkItemId as ULID) : null;
    const workItemId =
      typeof body.workItemId === 'string' && body.workItemId.trim()
        ? (body.workItemId.trim() as ULID)
        : null;
    const dispatcherSessionId =
      typeof body.dispatcherSessionId === 'string' ? body.dispatcherSessionId.trim() : '';
    if (!dispatcherSessionId) {
      return c.json(
        { ok: false, error: 'dispatcherSessionId required (orchestrator must forward PC_SESSION_ID)' },
        400,
      );
    }

    const parentInvokeDepth =
      typeof body.parentInvokeDepth === 'number' ? body.parentInvokeDepth : 0;
    const depthCheck = services.checkInvokeDepth(parentInvokeDepth);
    if (!depthCheck.ok) {
      return c.json({ ok: false, error: depthCheck.error, cause: depthCheck.cause }, 400);
    }

    const host = resolveHost();
    const result = await services.dispatchFreshAgent(
      {
        projectId,
        worktreeDir: project.folderPath,
        agentName,
        input,
        dispatcherSessionId,
        parentWorkItemId,
        workItemId,
        invokeDepth: depthCheck.childDepth,
        slug: project.slug,
      },
      {
        mailboxEnqueue,
        broadcast: (env) => deps.broadcastTo(projectId, env),
        ...(host ? { hostClient: host } : {}),
      },
    );

    if (!result.ok) {
      return c.json({ ok: false, error: result.error, cause: result.cause });
    }

    services.recordAgentInvoke({
      workItemId: parentWorkItemId,
      agentName,
      sessionId: result.ccSessionId,
      runId: result.agentRunId,
      mode: 'async',
      input,
      now: services.now(),
    });

    return c.json({
      ok: true,
      mode: 'async',
      sessionId: result.ccSessionId,
      runId: result.agentRunId,
      agentName: result.podName,
      startedAt: result.startedAt,
      status: result.initialState,
    });
  });

  /** `pc_continue_agent` HTTP surface. Ownership check + JSONL-retention guard
   *  + single-active-continuation guard, then spawn through the `AgentRun`
   *  wrapper. */
  app.post('/api/projects/:projectId/agent-runs/:runId/continue', async (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

    const parentAgentRunId = c.req.param('runId') as ULID;
    const body = await c.req.json<{
      input?: string;
      dispatcherSessionId?: string;
      workItemId?: ULID;
    }>();

    const input = typeof body.input === 'string' ? body.input : '';
    if (!input.trim()) return c.json({ ok: false, error: 'input required' }, 400);
    const dispatcherSessionId =
      typeof body.dispatcherSessionId === 'string' ? body.dispatcherSessionId.trim() : '';
    const continueWorkItemId =
      typeof body.workItemId === 'string' && body.workItemId.trim()
        ? (body.workItemId.trim() as ULID)
        : null;
    if (!dispatcherSessionId) {
      return c.json(
        { ok: false, error: 'dispatcherSessionId required (orchestrator must forward PC_SESSION_ID)' },
        400,
      );
    }

    const parentRow = getAgentRunRow(parentAgentRunId);
    if (!parentRow) {
      return c.json(
        { ok: false, error: `unknown run: ${parentAgentRunId}`, cause: 'run-not-found' },
        404,
      );
    }
    if (parentRow.projectId !== projectId) {
      return c.json(
        {
          ok: false,
          error: `run ${parentAgentRunId} not in project ${projectId}`,
          cause: 'wrong-project',
        },
        400,
      );
    }
    if (parentRow.dispatcherSessionId !== dispatcherSessionId) {
      return c.json(
        {
          ok: false,
          error: `run ${parentAgentRunId} was dispatched by a different orchestrator session — only the dispatcher can continue it`,
          cause: 'ownership-mismatch',
        },
        403,
      );
    }

    const host = resolveHost();
    const result = await services.dispatchContinueAgent(
      {
        projectId,
        worktreeDir: project.folderPath,
        parentAgentRunId,
        input,
        dispatcherSessionId,
        workItemId: continueWorkItemId,
        slug: project.slug,
      },
      {
        mailboxEnqueue,
        broadcast: (env) => deps.broadcastTo(projectId, env),
        ...(host ? { hostClient: host } : {}),
      },
    );

    if (!result.ok) {
      return c.json(
        { ok: false, error: result.error, cause: result.cause },
        continuationFailureStatus(result.cause) as 400,
      );
    }

    services.recordAgentInvoke({
      workItemId: parentRow.parentWorkItemId,
      agentName: result.podName,
      sessionId: result.ccSessionId,
      runId: result.agentRunId,
      mode: 'async',
      input,
      now: services.now(),
    });

    return c.json({
      ok: true,
      mode: 'async',
      sessionId: result.ccSessionId,
      runId: result.agentRunId,
      agentName: result.podName,
      startedAt: result.startedAt,
      status: result.initialState,
      continues: parentAgentRunId,
    });
  });

  /** `pc_list_my_runs` HTTP surface. Reads from the `agent_runs` table. */
  app.get('/api/projects/:projectId/agent-runs/by-dispatcher', (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

    const dispatcherSessionId = (c.req.query('dispatcherSessionId') ?? '').trim();
    if (!dispatcherSessionId) {
      return c.json({ ok: false, error: 'dispatcherSessionId query param required' }, 400);
    }
    const podName = (c.req.query('agentName') ?? '').trim() || undefined;
    const statusRaw = (c.req.query('status') ?? '').trim();
    const status =
      statusRaw && (VALID_AGENT_RUN_STATUSES as string[]).includes(statusRaw)
        ? (statusRaw as AgentRunStatus)
        : undefined;
    const limitRaw = Number(c.req.query('limit') ?? 20);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 20;

    const rows = listAgentRunsForSession(projectId, dispatcherSessionId, {
      podName,
      status,
      limit,
    });
    const SUMMARY_LEN = 80;
    const summarised = rows.map((r) => ({
      runId: r.id,
      agentName: r.podName,
      status: r.status,
      dispatchedAt: r.queuedAt,
      completedAt: r.completedAt,
      summary:
        (r.input ?? '').length > SUMMARY_LEN
          ? (r.input ?? '').slice(0, SUMMARY_LEN).trimEnd() + '…'
          : (r.input ?? ''),
      continues: r.continues,
    }));
    return c.json({ ok: true, runs: summarised });
  });

  /** Single pending-ask creation endpoint for `pc_ask_orchestrator` /
   *  `pc_ask_user` / `pc_request_approval`. */
  app.post('/api/projects/:projectId/agent-pending-asks', async (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const project = getProjectById(projectId);
    if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

    const body = await c.req.json<{
      agentRunId?: string;
      kind?: PendingAskKind;
      promptBody?: string;
      context?: string;
      options?: PendingAskOption[];
    }>();

    const agentRunId =
      typeof body.agentRunId === 'string' ? (body.agentRunId.trim() as ULID) : ('' as ULID);
    if (!agentRunId) return c.json({ ok: false, error: 'agentRunId required' }, 400);

    const kind = body.kind;
    if (kind !== 'orchestrator' && kind !== 'user' && kind !== 'approval') {
      return c.json(
        { ok: false, error: 'kind must be orchestrator | user | approval' },
        400,
      );
    }

    const promptBody = typeof body.promptBody === 'string' ? body.promptBody : '';
    if (!promptBody.trim()) return c.json({ ok: false, error: 'promptBody required' }, 400);

    if (kind === 'approval') {
      if (!Array.isArray(body.options) || body.options.length === 0) {
        return c.json(
          { ok: false, error: 'options required (non-empty array) for kind=approval' },
          400,
        );
      }
    }

    const result = await services.recordExplicitPause(
      {
        agentRunId,
        kind,
        promptBody,
        context: typeof body.context === 'string' ? body.context : null,
        options: Array.isArray(body.options) ? body.options : null,
      },
      {
        mailboxEnqueue,
        slug: project.slug,
        broadcast: (env) => deps.broadcastTo(projectId, env),
        // OBJ-2A — on-demand host level-read closes the early-ask race: a fresh
        // host round-trip when the DB row is still queued/spawning. Only wired
        // when an out-of-process host client is present; in-process omits it.
        ...(resolveHost() ? { hostRunState: hostRunStateReader } : {}),
      },
    );

    if (!result.ok) {
      const statusFor: Record<string, number> = {
        'unknown-run': 404,
        'wrong-state': 409,
      };
      return c.json(
        { ok: false, error: result.error, cause: result.cause },
        (statusFor[result.cause] ?? 400) as 400,
      );
    }

    return c.json({
      ok: true,
      pendingAskId: result.pendingAskId,
      status: 'waiting',
      eventDelivered: result.eventDelivered,
    });
  });

  /** `pc_answer_pending` HTTP surface. */
  app.post(
    '/api/projects/:projectId/agent-pending-asks/:askId/answer',
    async (c) => {
      const projectId = c.req.param('projectId') as ULID;
      const project = getProjectById(projectId);
      if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

      const pendingAskId = c.req.param('askId') as ULID;
      const body = await c.req.json<{
        answer?: string;
        answeredBy?: 'orchestrator' | 'user';
      }>();

      const answer = typeof body.answer === 'string' ? body.answer : '';
      if (!answer) return c.json({ ok: false, error: 'answer required' }, 400);
      const answeredBy = body.answeredBy;
      if (answeredBy !== 'orchestrator' && answeredBy !== 'user') {
        return c.json({ ok: false, error: 'answeredBy must be orchestrator | user' }, 400);
      }

      const result = await services.answerPendingAsk(
        { pendingAskId, answer, answeredBy },
        {
          slug: project.slug,
          broadcast: (env) => deps.broadcastTo(projectId, env),
        },
      );

      if (!result.ok) {
        const statusFor: Record<string, number> = {
          'unknown-pending-ask': 404,
          'already-answered': 409,
          cancelled: 409,
          'unknown-run': 404,
          'wrong-state': 409,
          'resume-failed': 500,
        };
        return c.json(
          { ok: false, error: result.error, cause: result.cause },
          (statusFor[result.cause] ?? 400) as 400,
        );
      }

      return c.json({
        ok: true,
        agentRunId: result.agentRunId,
        ccSessionId: result.ccSessionId,
        podRevisionDrifted: result.podRevisionDrifted,
        podRevisionAtDispatch: result.podRevisionAtDispatch,
        podRevisionAtResume: result.podRevisionAtResume,
      });
    },
  );

  /** v2 pending-ask cancel surface. Lets the orchestrator (or any caller) drop
   *  a pending pause without resuming the agent. */
  app.post(
    '/api/projects/:projectId/agent-pending-asks/:askId/cancel',
    async (c) => {
      const projectId = c.req.param('projectId') as ULID;
      const project = getProjectById(projectId);
      if (!project) return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);

      const pendingAskId = c.req.param('askId') as ULID;
      const result = services.cancelPendingAsk(
        { pendingAskId },
        { broadcast: (env) => deps.broadcastTo(projectId, env) },
      );
      if (!result.ok) {
        const statusFor: Record<string, number> = {
          'unknown-pending-ask': 404,
          'already-terminal': 409,
        };
        return c.json(
          { ok: false, error: result.error, cause: result.cause },
          (statusFor[result.cause] ?? 400) as 400,
        );
      }
      return c.json({ ok: true, agentRunId: result.agentRunId });
    },
  );
}
