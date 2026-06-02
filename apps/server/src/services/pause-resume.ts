// Section 25 Session 8 — pause / resume / continuation orchestration.
//
// Three primitives the v2 MCP tool surface (Session 9) calls into:
//
//   recordExplicitPause   — pc_ask_orchestrator / pc_ask_user /
//                              pc_request_approval tool fires. Writes
//                              pending_asks_v2 + flips AgentRun → paused +
//                              persists `paused` to agent_runs_v2 + delivers
//                              the agent-asks-* event through v2 hybrid
//                              transport.
//
//   answerPendingAsk      — pc_answer_pending tool fires (orchestrator
//                              answer) OR HTTP user-answer route fires.
//                              Atomic open→answered flip on the row,
//                              persists `spawning` + podRevisionAtResume to
//                              agent_runs_v2, drives the active run handle
//                              resume path (which spawns the resumed
//                              LowLevelSpawn). Same agent_run_id; the run
//                              record continues across the pause boundary.
//
//   continueAgent         — pc_continue_agent tool fires. Mints a fresh
//                              agent_run_id linked via `continues`. JSONL
//                              retention guard (404 with clear "session
//                              expired" message if CC's on-disk JSONL has
//                              been swept). Single-active-continuation guard
//                              (409 if a prior continuation is still in
//                              flight). Constructs a new AgentRun in resume
//                              mode + registers it with the active-runs
//                              registry.
//
// The orchestration writes through three layers in lock-step: AgentRun's
// in-memory state machine + the agent_runs_v2 row + the hybrid delivery
// pipeline. A failure in any layer surfaces as an explicit return value
// (never a thrown exception) so the caller can map it to a clean error
// response shape.

import { existsSync } from 'node:fs';

import {
  computePodRevision,
  findActiveContinuation,
  getAgentRunRow,
  getPendingAsk,
  getProjectById,
  insertAgentRunRow,
  markAgentRunTerminal,
  newId,
  resolveAgentForDispatch,
} from '@pc/db';
import { jsonlPathFor } from '@pc/runtime';
import type { AgentRunState } from '@pc/runtime';
import type {
  AgentInboxEventKind,
  AgentRunRow,
  AgentRunStatus,
  PendingAskKind,
  PendingAskOption,
  ULID,
} from '@pc/domain';

import { buildAgentEventHeader } from './agent-event-header.ts';
import { deliverAgentEnvelope, type MailboxEnqueuePort } from './agent-delivery.ts';
import { getActiveRunRegistry, type ActiveRunRegistry } from './agent-active-runs.ts';
import {
  answerAndResumeAgentRun,
  cancelAgentRun,
  commitAgentRunTerminal,
  pauseAgentRun,
} from './agent-run-writer.ts';

// ──────────────────────────── EXPLICIT PAUSE ──────────────────────────────

export interface RecordExplicitPauseInput {
  agentRunId: ULID;
  kind: PendingAskKind;
  promptBody: string;
  context?: string | null;
  options?: PendingAskOption[] | null;
  now?: number;
}

export type RecordExplicitPauseResult =
  | {
      ok: true;
      pendingAskId: ULID;
      eventDelivered: boolean;
      eventInboxId: ULID | null;
    }
  | { ok: false; error: string; cause: 'unknown-run' | 'wrong-state' };

export interface PauseResumeDeps {
  /** Mailbox enqueue port — the agent-asks-* envelope is delivered through it.
   *  Only the envelope DELIVERY rides this; the pending_asks state +
   *  agent.run.changed fact (slice 005) are untouched. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  /** Slug embedded in the envelope. Production = `'pc-orchestrator'`. */
  slug: string;
  /** Source embedded in the envelope. Production = `'agent'`. */
  source?: string;
  /** Sender embedded in the envelope. Production = `'pc'`. */
  sender?: string;
  /** Active-run lookup. Defaults to the process-wide singleton. */
  registry?: ActiveRunRegistry;
  /** OBJ-2A — read the RECONCILED DB row status for the pause/resume gates
   *  instead of the (unreliably-fed) in-memory handle snapshot. Default
   *  `@pc/db` getAgentRunRow. */
  getAgentRun?: (id: ULID) => AgentRunRow | null;
  /** OBJ-2A — optional ON-DEMAND host level-read. When the DB row is
   *  non-terminal but not yet running/paused (the early-ask race before the
   *  first 15s reconcile sweep), the gate awaits a fresh host round-trip and
   *  prefers it. Production wires a host-client-backed reader; in-process
   *  callers omit it (the DB row is authoritative there). */
  hostRunState?: (id: ULID) => Promise<AgentRunState | null>;
  /** Slice 005 — per-project WS fanout for the durable agent.run.changed fact
   *  (canonical frame + legacy `agent-run-changed`). Tests can omit (no-op). */
  broadcast?: (event: unknown) => void;
  /** Test seam: override the "is JSONL still on disk?" check. */
  jsonlExists?: (path: string) => boolean;
  /** Test seam: override now(). */
  now?: () => number;
}

/** Pause a running AgentRun in response to a pc_ask_* tool call. Mints a
 *  pending_asks_v2 row, flips the run paused, delivers the agent-asks-*
 *  event to the dispatcher's session through the hybrid transport. */
export async function recordExplicitPause(
  input: RecordExplicitPauseInput,
  deps: PauseResumeDeps,
): Promise<RecordExplicitPauseResult> {
  const reg = deps.registry ?? getActiveRunRegistry();
  const now = (deps.now ?? Date.now)();

  const entry = reg.get(input.agentRunId);
  if (!entry) {
    return {
      ok: false,
      error: `no active run with id ${input.agentRunId}`,
      cause: 'unknown-run',
    };
  }

  // OBJ-2A — DECIDE on the RECONCILED DB row, not the in-memory handle. The
  // handle snapshot is a third projection fed only by the unreliable event
  // stream (ADR violation); for a fresh host-backed run it can sit at
  // queued/spawning long after the row reached `running`. Keep `entry` above
  // for IDENTITY/metadata + markPaused delivery; only the state DECISION moves.
  const row = (deps.getAgentRun ?? getAgentRunRow)(input.agentRunId);
  let runState: AgentRunStatus | AgentRunState | null = row?.status ?? null;
  // Early-ask race: row still queued/spawning before the first sweep tick. Do a
  // single on-demand host level-read and prefer it (reconcile-on-demand).
  if (
    runState !== 'running' &&
    runState !== 'paused' &&
    !isTerminalStatus(runState) &&
    deps.hostRunState
  ) {
    const hostState = await deps.hostRunState(input.agentRunId);
    if (hostState) runState = hostState;
  }
  if (runState !== 'running') {
    return {
      ok: false,
      error: `run ${input.agentRunId} is ${runState ?? 'unknown'}, not running`,
      cause: 'wrong-state',
    };
  }

  const pendingAskId = newId();

  // Slice 005 — write the open ask + the `paused` run transition + the durable
  // agent.run.changed (reason:'paused', pendingAskId) fact in ONE transaction
  // through the gateway, then fan out canonical + legacy. The runtime markPaused
  // + the agent-asks-* delivery stay post-commit (best-effort).
  pauseAgentRun(
    {
      pendingAsk: {
        id: pendingAskId,
        agentRunId: input.agentRunId,
        ccSessionId: entry.ccSessionId,
        projectId: entry.projectId,
        parentWorkItemId: entry.parentWorkItemId,
        kind: input.kind,
        promptBody: input.promptBody,
        context: input.context ?? null,
        options: input.options ?? null,
        now,
      },
    },
    deps.broadcast,
  );

  // Mark the run paused in the runtime state machine (post-commit). AWAIT it:
  // for host-backed runs this blocks on the host applying `paused` before we
  // return — and thus before the agent's pc_ask_* tool call returns and the
  // agent ends its turn. Without the await the host would tail the turn-end and
  // complete the run before the fire-and-forget mark-paused landed, dropping
  // the answer (slice 009 OBJ-2). In-process markPaused is synchronous.
  await entry.run.markPaused(pendingAskId);

  // Deliver the agent-asks-* event to the dispatcher session.
  const kindMap: Record<PendingAskKind, AgentInboxEventKind> = {
    orchestrator: 'agent-asks-orchestrator',
    user: 'agent-asks-user',
    approval: 'agent-approval-request',
  };
  const eventKind = kindMap[input.kind];
  const body = buildPauseEventBody({
    eventKind,
    pendingAskId,
    sessionId: entry.ccSessionId,
    podName: entry.podName,
    runId: input.agentRunId,
    parentWorkItemId: entry.parentWorkItemId,
    promptBody: input.promptBody,
    context: input.context ?? null,
    options: input.options ?? null,
  });

  const mailboxEnqueue = deps.mailboxEnqueue;
  const pushResult = mailboxEnqueue
    ? deliverAgentEnvelope(
        {
          projectId: entry.projectId,
          pcSessionId: entry.dispatcherSessionId,
          kind: eventKind,
          slug: deps.slug,
          source: deps.source ?? 'agent',
          body,
          sender: deps.sender ?? 'pc',
          idempotencyKey: `agent-ask:${pendingAskId}`,
          sourceId: pendingAskId,
        },
        { mailboxEnqueue },
      )
    : { inboxId: null, channelDelivered: false };

  return {
    ok: true,
    pendingAskId,
    eventDelivered: pushResult.channelDelivered,
    eventInboxId: pushResult.inboxId,
  };
}

// ──────────────────────────── ANSWER + RESUME ─────────────────────────────

export interface AnswerPendingAskInput {
  pendingAskId: ULID;
  answer: string;
  answeredBy: 'orchestrator' | 'user';
  now?: number;
}

export type AnswerPendingAskResult =
  | {
      ok: true;
      agentRunId: ULID;
      ccSessionId: string;
      /** True iff the pod row was edited between dispatch and resume. */
      podRevisionDrifted: boolean;
      podRevisionAtDispatch: string | null;
      podRevisionAtResume: string | null;
    }
  | {
      ok: false;
      error: string;
      cause:
        | 'unknown-pending-ask'
        | 'already-answered'
        | 'cancelled'
        | 'unknown-run'
        | 'wrong-state'
        | 'resume-failed';
    };

/** Atomically flip the pending-ask row to answered and resume the paused
 *  AgentRun by typing the answer back through a fresh LowLevelSpawn in
 *  resume mode. Same agent_run_id; the run record continues across the
 *  pause boundary. */
export async function answerPendingAsk(
  input: AnswerPendingAskInput,
  deps: PauseResumeDeps,
): Promise<AnswerPendingAskResult> {
  const reg = deps.registry ?? getActiveRunRegistry();
  const now = (deps.now ?? Date.now)();

  const ask = getPendingAsk(input.pendingAskId);
  if (!ask) {
    return {
      ok: false,
      error: `no pending-ask with id ${input.pendingAskId}`,
      cause: 'unknown-pending-ask',
    };
  }
  if (ask.status === 'answered') {
    return {
      ok: false,
      error: `pending-ask ${input.pendingAskId} already answered`,
      cause: 'already-answered',
    };
  }
  if (ask.status === 'cancelled') {
    return {
      ok: false,
      error: `pending-ask ${input.pendingAskId} was cancelled`,
      cause: 'cancelled',
    };
  }

  // Slice 005 — validate resumability BEFORE the open->answered flip so a
  // non-resumable answer does NOT strand an answered ask (closes handoff High
  // issue #1). The atomic `WHERE status='open'` flip then happens inside the
  // gateway tx (JSONL-replay-safe: a replayed answer is a no-op → emits
  // nothing).
  const entry = reg.get(ask.agentRunId);
  if (!entry) {
    return {
      ok: false,
      error: `agent run ${ask.agentRunId} is not active`,
      cause: 'unknown-run',
    };
  }
  // OBJ-2A — gate on the RECONCILED DB row status, not the handle snapshot
  // (same unreconciled-projection class as the pause gate). `entry` is still
  // required to drive the resume command below.
  const resumeRow = (deps.getAgentRun ?? getAgentRunRow)(ask.agentRunId);
  if ((resumeRow?.status ?? null) !== 'paused') {
    return {
      ok: false,
      error: `agent run ${ask.agentRunId} is ${resumeRow?.status ?? 'unknown'}, not paused`,
      cause: 'wrong-state',
    };
  }

  // Capture pod revision at resume for drift detection.
  const projectIdForPod = lookupPodScope(entry.podName, entry.projectId);
  const podRevisionAtResume = computePodRevision({
    podName: entry.podName,
    projectId: projectIdForPod,
  });

  // Atomic flip (open->answered) + persist `spawning` + drift field + the
  // durable agent.run.changed (reason:'resumed') fact, all in ONE transaction
  // through the gateway. A no-op flip (concurrent/replayed answer) returns null.
  const pub = answerAndResumeAgentRun(
    {
      pendingAskId: ask.id,
      agentRunId: ask.agentRunId,
      answer: input.answer,
      answeredBy: input.answeredBy,
      now,
      podRevisionAtResume,
      worktreeDir: '',
    },
    deps.broadcast,
  );
  if (!pub) {
    return {
      ok: false,
      error: `pending-ask ${input.pendingAskId} was answered concurrently`,
      cause: 'already-answered',
    };
  }

  // Drive the run. The active handle transitions paused -> spawning ->
  // running and constructs a fresh LowLevelSpawn in resume mode with the
  // answer as the typed first user turn in in-process mode. A post-flip resume
  // failure finalizes the run through the gateway to a recoverable terminal
  // state rather than leaving an answered ask with a stuck run.
  //
  // Slice 009 OBJ-2 — host path: `resumeWithAnswer` now AWAITS the host command
  // and reports a `not-resumable` reply (the host run was not actually paused,
  // so the answer was dropped). On that result we finalize the run here instead
  // of leaving it stranded `running` for the idle sweep. In-process always
  // returns `ok` (resumability was pre-validated above).
  let resume: Awaited<ReturnType<typeof entry.run.resumeWithAnswer>>;
  try {
    resume = await entry.run.resumeWithAnswer(input.answer);
  } catch (err) {
    commitAgentRunTerminal(
      {
        runId: ask.agentRunId,
        status: 'failed',
        result: null,
        failureCause: 'spawn-error',
        failureReason: `resume failed: ${(err as Error).message}`,
        completedAt: (deps.now ?? Date.now)(),
      },
      deps.broadcast,
    );
    return {
      ok: false,
      error: `resume failed: ${(err as Error).message}`,
      cause: 'resume-failed',
    };
  }
  if (!resume.ok) {
    commitAgentRunTerminal(
      {
        runId: ask.agentRunId,
        status: 'failed',
        result: null,
        failureCause: 'spawn-error',
        failureReason: `resume failed: ${resume.error}`,
        completedAt: (deps.now ?? Date.now)(),
      },
      deps.broadcast,
    );
    return {
      ok: false,
      error: `resume failed: ${resume.error}`,
      cause: 'resume-failed',
    };
  }

  return {
    ok: true,
    agentRunId: ask.agentRunId,
    ccSessionId: ask.ccSessionId,
    podRevisionDrifted:
      entry.podRevisionAtDispatch !== null &&
      podRevisionAtResume !== null &&
      entry.podRevisionAtDispatch !== podRevisionAtResume,
    podRevisionAtDispatch: entry.podRevisionAtDispatch,
    podRevisionAtResume,
  };
}

// ──────────────────────────── CANCEL PAUSE ────────────────────────────────

export interface CancelPendingAskInput {
  pendingAskId: ULID;
  now?: number;
}

export type CancelPendingAskResult =
  | { ok: true; agentRunId: ULID }
  | { ok: false; error: string; cause: 'unknown-pending-ask' | 'already-terminal' };

/** Cancel a paused agent — flip the pending-ask row to cancelled and
 *  cancel the underlying AgentRun. The orchestration is idempotent: a
 *  second cancel returns `already-terminal`. */
export function cancelPendingAsk(
  input: CancelPendingAskInput,
  deps: Pick<PauseResumeDeps, 'registry' | 'now' | 'broadcast'>,
): CancelPendingAskResult {
  const reg = deps.registry ?? getActiveRunRegistry();
  const now = (deps.now ?? Date.now)();

  const ask = getPendingAsk(input.pendingAskId);
  if (!ask) {
    return {
      ok: false,
      error: `no pending-ask with id ${input.pendingAskId}`,
      cause: 'unknown-pending-ask',
    };
  }
  if (ask.status !== 'open') {
    return {
      ok: false,
      error: `pending-ask ${input.pendingAskId} is ${ask.status}`,
      cause: 'already-terminal',
    };
  }

  // Slice 005 — finalize the agent_runs row to `cancelled` durably (+ cancel the
  // open ask) in ONE transaction through the gateway EVEN WHEN no registry
  // handle exists (phantom paused run — closes handoff High issue #2), then fan
  // out canonical + legacy. The runtime cancel is best-effort post-commit.
  cancelAgentRun(
    {
      runId: ask.agentRunId,
      now,
      failureCause: 'cancelled',
      failureReason: 'pending ask cancelled',
      cancelOpenAsk: ask.id,
    },
    deps.broadcast,
  );

  const entry = reg.get(ask.agentRunId);
  if (entry) entry.run.cancel();

  return { ok: true, agentRunId: ask.agentRunId };
}

// ──────────────────────────── CONTINUATION ────────────────────────────────

export interface ContinueAgentInput {
  parentAgentRunId: ULID;
  input: string;
  /** Optional pre-minted run id. Production callers let the orchestration
   *  mint a fresh ULID; tests can supply one for determinism. */
  newAgentRunId?: ULID;
  now?: number;
}

export interface ContinueAgentPlan {
  /** Newly minted agent_run_id (already inserted with `status: queued`). */
  agentRunId: ULID;
  /** Same CC provider session-id as the parent — the resumed spawn uses
   *  `--resume <ccSessionId>`. */
  ccSessionId: string;
  dispatcherSessionId: string;
  projectId: ULID;
  parentWorkItemId: ULID | null;
  podName: string;
  /** Captured pod revision at this dispatch. Stored on the new row. */
  podRevisionAtDispatch: string | null;
  parentInvokeDepth: number;
  /** The verbatim input the caller passed. The wrapper will type this as
   *  the first user turn after the resume gate opens. */
  input: string;
}

export type ContinueAgentResult =
  | { ok: true; plan: ContinueAgentPlan }
  | {
      ok: false;
      error: string;
      cause:
        | 'run-not-found'
        | 'not-continuable'
        | 'concurrent-continuation'
        | 'session-expired'
        | 'project-missing';
    };

export interface ContinueDeps {
  /** Test seam — defaults to fs.existsSync over the resolved JSONL path. */
  jsonlExists?: (path: string) => boolean;
  now?: () => number;
}

/** Plan a continuation dispatch:
 *   - Validate the parent run is terminal (completed | failed) and that
 *     its on-disk JSONL still exists.
 *   - Reject if another continuation of the same parent is already in
 *     flight.
 *   - Compute pod revision at this dispatch.
 *   - Insert a fresh agent_runs_v2 row with `status: queued` + `continues:
 *     <parent>`.
 *
 *  Returns the plan; the caller (MCP tool / HTTP route) is responsible
 *  for constructing the AgentRun with this plan + registering it.
 *  Splitting "plan" from "construct" keeps this module testable without
 *  node-pty in scope. */
export function continueAgent(
  input: ContinueAgentInput,
  deps: ContinueDeps = {},
): ContinueAgentResult {
  const now = (deps.now ?? Date.now)();
  const jsonlExists = deps.jsonlExists ?? existsSync;

  const parent = getAgentRunRow(input.parentAgentRunId);
  if (!parent) {
    return {
      ok: false,
      error: `parent run ${input.parentAgentRunId} not found`,
      cause: 'run-not-found',
    };
  }
  if (parent.status !== 'completed' && parent.status !== 'failed') {
    return {
      ok: false,
      error: `parent run is ${parent.status}; only completed/failed runs can be continued`,
      cause: 'not-continuable',
    };
  }

  // Single-active-continuation guard.
  const inflight = findActiveContinuation(parent.id);
  if (inflight) {
    return {
      ok: false,
      error: `parent run ${parent.id} already has continuation ${inflight.id} in flight`,
      cause: 'concurrent-continuation',
    };
  }

  // JSONL retention guard.
  const project = getProjectById(parent.projectId);
  if (!project) {
    return {
      ok: false,
      error: `project ${parent.projectId} not found for parent run`,
      cause: 'project-missing',
    };
  }
  const jsonlPath = jsonlPathFor(project.folderPath, parent.ccSessionId);
  if (!jsonlExists(jsonlPath)) {
    return {
      ok: false,
      error: `session expired — CC's on-disk JSONL at ${jsonlPath} has been swept; start a fresh dispatch instead of continuing`,
      cause: 'session-expired',
    };
  }

  const projectIdForPod = lookupPodScope(parent.podName, parent.projectId);
  const podRevisionAtDispatch = computePodRevision({
    podName: parent.podName,
    projectId: projectIdForPod,
  });

  const newRunId = (input.newAgentRunId ?? newId()) as ULID;
  insertAgentRunRow({
    id: newRunId,
    projectId: parent.projectId,
    podName: parent.podName,
    dispatcherSessionId: parent.dispatcherSessionId,
    ccSessionId: parent.ccSessionId,
    status: 'queued',
    input: input.input,
    parentWorkItemId: parent.parentWorkItemId,
    parentInvokeDepth: parent.parentInvokeDepth,
    continues: parent.id,
    podRevisionAtDispatch,
    queuedAt: now,
  });

  return {
    ok: true,
    plan: {
      agentRunId: newRunId,
      ccSessionId: parent.ccSessionId,
      dispatcherSessionId: parent.dispatcherSessionId,
      projectId: parent.projectId,
      parentWorkItemId: parent.parentWorkItemId,
      podName: parent.podName,
      podRevisionAtDispatch,
      parentInvokeDepth: parent.parentInvokeDepth,
      input: input.input,
    },
  };
}

// ──────────────────────────── HELPERS ─────────────────────────────────────

/** Terminal statuses — used by the pause gate to skip the on-demand host
 *  level-read for an already-finished run. */
function isTerminalStatus(
  status: AgentRunStatus | AgentRunState | null,
): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Resolve the SAME pod row the dispatch path resolved (mirrors
 *  agent-run-factory.ts:364-367), returning the project id only for a
 *  project-scoped resolved pod and null for a global pod — so
 *  computePodRevision queries the same row dispatch stored. */
function lookupPodScope(podName: string, projectId: ULID): ULID | null {
  const agent = resolveAgentForDispatch(podName, projectId);
  if (!agent) return null;
  return agent.scope === 'project' ? (agent.projectId as ULID | null) : null;
}

interface PauseEventBodyArgs {
  eventKind: AgentInboxEventKind;
  pendingAskId: ULID;
  sessionId: string;
  podName: string;
  runId: ULID;
  parentWorkItemId: ULID | null;
  promptBody: string;
  context: string | null;
  options: PendingAskOption[] | null;
}

/** Compose the <channel source="agent" ...> body for a pause event. Same
 *  header tag set as the v1 channel builders so the
 *  orchestrator's pod prompt parser keeps working unchanged. */
function buildPauseEventBody(args: PauseEventBodyArgs): string {
  const lines: string[] = [
    buildAgentEventHeader(args.eventKind as never),
    `[pendingAskId: ${args.pendingAskId}]`,
    `[sessionId: ${args.sessionId}]`,
    `[agentName: ${args.podName}]`,
    `[runId: ${args.runId}]`,
  ];
  if (args.parentWorkItemId) {
    lines.push(`[parentWorkItemId: ${args.parentWorkItemId}]`);
  }
  lines.push('');
  switch (args.eventKind) {
    case 'agent-asks-orchestrator':
      lines.push('Question:');
      lines.push(args.promptBody);
      break;
    case 'agent-asks-user':
      lines.push('Question for the user:');
      lines.push(args.promptBody);
      break;
    case 'agent-approval-request':
      lines.push('Approval requested:');
      lines.push(args.promptBody);
      break;
    default:
      lines.push(args.promptBody);
  }
  if (args.context) {
    lines.push('');
    lines.push('Context:');
    lines.push(args.context);
  }
  if (args.options && args.options.length > 0) {
    lines.push('');
    lines.push('Options:');
    args.options.forEach((opt, idx) => {
      lines.push(`${idx + 1}. ${opt.label} (value: ${opt.value})`);
    });
  }
  lines.push('');
  lines.push(
    `Answer via pc_answer_pending with the pendingAskId above. Check status first — replay can re-fire this event.`,
  );
  return lines.join('\n');
}

// ──────────────────────────── TERMINAL HELPERS ────────────────────────────

export interface PersistAgentRunTerminalInput {
  agentRunId: ULID;
  status: 'completed' | 'failed' | 'cancelled';
  result: string | null;
  failureCause: ConstructorParameters<typeof Object>[0] extends never
    ? never
    : import('@pc/domain').AgentRunFailureCause | null;
  failureReason: string | null;
  completedAt: number;
}

/** Persist a terminal transition on agent_runs_v2. The active-runs
 *  registry auto-unregisters on the AgentRun's `terminal` event, so this
 *  is just the persistence half — emit-side is the caller's job. */
export function persistAgentRunTerminal(
  input: PersistAgentRunTerminalInput,
): void {
  markAgentRunTerminal({
    id: input.agentRunId,
    status: input.status,
    result: input.result,
    failureCause: input.failureCause as never,
    failureReason: input.failureReason,
    completedAt: input.completedAt,
  });
}
