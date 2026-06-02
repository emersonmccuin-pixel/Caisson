// Section 25 — AgentRun construction + registration helper.
//
// The orchestration layer the HTTP routes call through. Sits on top of:
//
//   - `continueAgent` (mints the `agent_runs` row + computes pod revision
//     for continuation dispatches).
//   - `AgentRun` + `AgentRunRegistry` wrappers from @pc/runtime.
//   - `preparePodSpawn` (pod materialisation via the shared `materializePod`).
//   - `getActiveRunRegistry` (process-wide indexed lookup the pause/resume
//     layer queries).
//   - `deliverAgentEnvelope` (mailbox delivery for terminal/queued envelopes).
//
// Responsibilities:
//
//   - `dispatchFreshAgent`: validates the pod exists, materialises it, mints
//     fresh agent_run_id + cc_provider_session_id (UUID), inserts an
//     `agent_runs` row with `status: 'queued'` (the AgentRunRegistry decides
//     whether the queue is full or the run goes straight to spawning),
//     constructs the AgentRun, registers it with active-runs, wires terminal
//     persistence + channel-event emission, calls `run.start()`.
//
//   - `dispatchContinueAgent`: validates the parent run + JSONL retention
//     guard + concurrent-continuation guard (`continueAgent` plan does this),
//     materialises the pod (same name as parent), constructs the AgentRun in
//     mode='resume' with the parent's cc_provider_session_id, wires terminal
//     handlers + start.
//
// Production callers: the two HTTP routes
// (`/api/projects/:projectId/agents/:name/invoke` and
// `/api/projects/:projectId/agent-runs/:runId/continue`).

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  computePodRevision,
  resolveAgentForDispatch,
  getWorkItem,
  insertAgentRunRow,
  markAgentRunTerminal,
  newId,
  setAssignedAgentRunId,
  touchAgentRunActivity,
  updateAgentRunPid,
  updateAgentRunStatus,
} from '@pc/db';
import type {
  AgentInboxEventKind,
  ExpectedOutput,
  ULID,
} from '@pc/domain';
import type { AgentRunChangedReason } from '@pc/contracts';
import {
  AgentRun,
  AgentRunRegistry,
  type AgentHostCommandResponse,
  type AgentHostEvent,
  type AgentHostResumeRunRequest,
  type AgentHostRunSnapshot,
  type AgentHostStartRunRequest,
} from '@pc/runtime';
import type { AgentRunRecord } from '@pc/runtime';

import {
  buildAgentQueuedStartedBody,
} from './agent-event-header.ts';
import { preparePodSpawn, type PodSpawnPrep } from './pod-spawn.ts';

import {
  activeRunHandleForAgentRun,
  getActiveRunRegistry,
  HostBackedActiveRunHandle,
  type ActiveRunRegistry,
} from './agent-active-runs.ts';
import {
  applyAgentHostEvent,
  applyHostTerminalSnapshot,
  type AgentHostReattachClient,
} from './agent-host-reattach.ts';
import { deliverAgentEnvelope, type MailboxEnqueuePort } from './agent-delivery.ts';
import { continueAgent, type ContinueAgentResult } from './pause-resume.ts';
import {
  runVerificationOnTerminal,
  type VerificationDeps,
} from './agent-verification.ts';
import { applyAgentRunTerminalEffects } from './agent-run-terminal-effects.ts';
import { announceAgentRunChange } from './agent-run-writer.ts';

/** Process-wide cap-and-queue registry shared by every dispatch. Lives in
 *  the runtime layer; we hold one singleton in this module so every
 *  route+spawn agrees on the active count. Tests inject their own via the
 *  deps argument on the helpers below. */
let runRegistrySingleton: AgentRunRegistry | null = null;
function getRunRegistry(): AgentRunRegistry {
  if (!runRegistrySingleton) runRegistrySingleton = new AgentRunRegistry();
  return runRegistrySingleton;
}

/** Test-only override. Pass `null` to revert to a fresh singleton on next
 *  read. */
export function setRunRegistryForTest(reg: AgentRunRegistry | null): void {
  runRegistrySingleton = reg;
}

export interface DispatchFreshAgentInput {
  projectId: ULID;
  /** Absolute path to the project's worktree. Becomes the spawn cwd + the
   *  worktree-bind root for the path-guard hook. */
  worktreeDir: string;
  agentName: string;
  /** First user message body. Echo-ack via bracketed paste after the gate. */
  input: string;
  /** PC session-id of the dispatcher (orchestrator's `PC_SESSION_ID`). */
  dispatcherSessionId: string;
  /** Optional work-item the dispatch is attached to. Forwarded to the agent
   *  via `PC_AGENT_PARENT_WORK_ITEM_ID`. */
  parentWorkItemId?: ULID | null;
  /** Section 26.4 — work-item-as-contract. When supplied, the dispatch is
   *  the agent's assigned contract: the materialiser appends a "## Your
   *  assignment" section to the rendered .md with `pc_get_work_item({id})`
   *  + the active `expected_output` JSON. Also sets `PC_AGENT_WORK_ITEM_ID`
   *  on the spawn env. Caller (orchestrator) creates the work item via
   *  `pc_create_agent_work_item`, then passes the returned ULID here. */
  workItemId?: ULID | null;
  /** Caller's nesting depth + 1. The orchestrator dispatches at depth 1; an
   *  agent dispatched by that one runs at depth 2. */
  invokeDepth: number;
  /** Project slug — embedded in delivery envelopes so the orchestrator can
   *  pin a channel POST back to its source project. */
  slug: string;
}

export interface DispatchContinueAgentInput {
  projectId: ULID;
  worktreeDir: string;
  /** Parent run id to continue. Same scope rules as Session 8's
   *  `continueAgent` — parent must be terminal completed/failed, JSONL
   *  must still be on disk, no other continuation in flight. */
  parentAgentRunId: ULID;
  input: string;
  /** Caller's PC session-id. Used for ownership check against the parent
   *  run's `dispatcher_session_id` BEFORE we plan the continuation. */
  dispatcherSessionId: string;
  /** Section 26.4 — work-item-as-contract carries through continuations too.
   *  When supplied, the resumed dispatch re-emits the assignment header so
   *  the continued agent sees the same (or a swapped-in) contract. NULL =
   *  carry the parent run's `parent_work_item_id` as the assignment if it
   *  had one. */
  workItemId?: ULID | null;
  /** Project slug — embedded in delivery envelopes. */
  slug: string;
}

export interface DispatchAgentDeps {
  /** Mailbox enqueue port — agent envelopes are delivered through it. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  /** Inject for tests. Defaults to the process-wide singletons. */
  runRegistry?: AgentRunRegistry;
  activeRunRegistry?: ActiveRunRegistry;
  /** Override the per-run scratch dir. Defaults to `<PC_DATA_DIR>/projects/
   *  <projectId>/agent-runs-v2/<runId>`. */
  scratchDirFor?: (projectId: ULID, agentRunId: ULID) => string;
  /** Section 26.5 — inject the verification runner for tests. Production
   *  uses `runVerificationOnTerminal` with worktree-bound `PredicateExecutors`. */
  verifyOnTerminal?: typeof runVerificationOnTerminal;
  /** Section 26.5 — passthrough deps for the production verification runner
   *  (mostly the `executorsFor` test seam). Tests usually inject
   *  `verifyOnTerminal` directly instead. */
  verificationDeps?: VerificationDeps;
  /** Test seam: AgentRun factory. Production = `new AgentRun(...)`. */
  agentRunFactory?: typeof defaultAgentRunFactory;
  /** Phase C host-mode seam. When supplied, dispatches are sent to the
   *  out-of-process host; when omitted, production stays in-process. */
  hostClient?: AgentHostReattachClient;
  /** Session 10 / Phase D — WS broadcast hook. Carries:
   *   - `{ type: 'agent-run-changed', record }` on state transition + terminal
   *     (Activity Panel adapter shim — v1-shape `AgentRunRecord`).
   *   - `{ type: 'agent-jsonl-event', runId, event }` per JSONL event
   *     (Activity Panel live-transcript modal — filtered by runId).
   *  Production wires this to apps/server's `broadcastTo(projectId, env)`.
   *  Tests can leave it undefined (no-op). */
  broadcast?: (env: { type: string; [key: string]: unknown }) => void;
  now?: () => number;
}

export interface DispatchAgentSuccess {
  ok: true;
  agentRunId: ULID;
  ccSessionId: string;
  podName: string;
  /** Run record snapshot immediately after `start()` — state is `queued` or
   *  `spawning` depending on cap. */
  initialState: 'queued' | 'spawning';
  startedAt: number;
}

export type DispatchAgentFailure =
  | {
      ok: false;
      cause: 'unknown-agent';
      error: string;
    }
  | {
      ok: false;
      cause: 'pod-materialisation-failed';
      error: string;
    }
  | {
      ok: false;
      cause: 'scratch-mkdir-failed';
      error: string;
    }
  | {
      ok: false;
      cause: 'host-unavailable' | 'host-protocol-error';
      error: string;
    }
  | {
      ok: false;
      cause: ContinueAgentResult extends { ok: false; cause: infer C } ? C : never;
      error: string;
    };

export type DispatchAgentResult = DispatchAgentSuccess | DispatchAgentFailure;

// ─────────────────────────────── FRESH DISPATCH ──────────────────────────────

/** Validate, materialise, persist, construct, register, start. Returns a
 *  cause-tagged failure if any pre-spawn step fails; only the post-start
 *  failures funnel through the agent_runs_v2 row's terminal state. */
export async function dispatchFreshAgent(
  input: DispatchFreshAgentInput,
  deps: DispatchAgentDeps,
): Promise<DispatchAgentResult> {
  const now = (deps.now ?? Date.now)();

  // Fail fast on unknown agent — pre-row-insert so the orchestrator can
  // distinguish "you asked for a nonexistent pod" from "the pod ran and
  // failed." Resolution prefers a project-scoped pod with this name, falls
  // back to global. (Section 22.1 — stabilization fix.)
  const podRow = resolveAgentForDispatch(input.agentName, input.projectId);
  if (!podRow) {
    return {
      ok: false,
      cause: 'unknown-agent',
      error: `no agent named "${input.agentName}" found in pod registry`,
    };
  }

  const agentRunId = newId() as ULID;
  const ccSessionId = randomUUID();
  const scratchDirFn = deps.scratchDirFor ?? defaultScratchDirFor;
  const scratchDir = scratchDirFn(input.projectId, agentRunId);

  try {
    mkdirSync(scratchDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      cause: 'scratch-mkdir-failed',
      error: `scratchDir mkdir failed: ${(err as Error).message}`,
    };
  }

  // Section 26.4 — resolve the work-item-as-contract assignment if supplied.
  // The materialiser writes a "## Your assignment" section into the rendered
  // .md when this is non-null; the orchestrator created the work item before
  // dispatching so we just look it up here. Hard-fail on unknown/archived ids
  // — the orchestrator can't dispatch against a phantom contract.
  let workItem: { workItemId: ULID; expectedOutput: ExpectedOutput } | null = null;
  if (input.workItemId) {
    const wi = getWorkItem(input.workItemId);
    if (!wi) {
      return {
        ok: false,
        cause: 'pod-materialisation-failed',
        error: `workItemId "${input.workItemId}" not found or archived`,
      };
    }
    if (!wi.expectedOutput) {
      return {
        ok: false,
        cause: 'pod-materialisation-failed',
        error: `workItem "${input.workItemId}" has no expected_output — was it created via pc_create_agent_work_item?`,
      };
    }
    workItem = { workItemId: input.workItemId, expectedOutput: wi.expectedOutput };
  }

  let podPrep: PodSpawnPrep | null = null;
  try {
    podPrep = preparePodSpawn({
      agentName: input.agentName,
      projectId: input.projectId,
      worktreeDir: input.worktreeDir,
      scratchDir,
      filterMcpToReferencedTools: true,
      workItem: workItem ?? undefined,
    });
  } catch (err) {
    return {
      ok: false,
      cause: 'pod-materialisation-failed',
      error: `pod materialisation failed for "${input.agentName}": ${(err as Error).message}`,
    };
  }
  // Pre-row-validated above — a returned null here means a pod row exists in
  // the registry but `getPodForSpawn` rejected it (e.g. soft-deleted between
  // the validation read and the spawn read). Treat as unknown-agent.
  if (!podPrep) {
    return {
      ok: false,
      cause: 'unknown-agent',
      error: `pod "${input.agentName}" disappeared between validation and spawn`,
    };
  }

  // Pod-revision must match the row we actually resolved — when the dispatch
  // resolved a project-scoped pod, the revision query must scope to that
  // project too. (Section 22.1 fix: previously always passed null → drift if a
  // project pod was edited.)
  const podRevisionAtDispatch = computePodRevision({
    podName: input.agentName,
    projectId: podPrep.podScope === 'project' ? podPrep.podProjectId : null,
  });

  // When a contract WI is supplied, store it on the agent_runs row's
  // `parent_work_item_id` slot — that field is the bidirectional link 26.5
  // will use to find the WI on terminal eval. Falls back to the dispatcher-
  // lineage `parentWorkItemId` for legacy callers that didn't pass a contract.
  const parentWorkItemForRow: ULID | null =
    (workItem?.workItemId as ULID | undefined) ?? input.parentWorkItemId ?? null;

  // Insert the row BEFORE constructing the AgentRun. If the wrapper throws
  // during construction (shouldn't, but defensively), we still have a row to
  // reconcile-orphan at the next boot.
  insertAgentRunRow({
    id: agentRunId,
    projectId: input.projectId,
    podName: input.agentName,
    dispatcherSessionId: input.dispatcherSessionId,
    ccSessionId,
    status: 'queued',
    input: input.input,
    parentWorkItemId: parentWorkItemForRow,
    parentInvokeDepth: input.invokeDepth,
    continues: null,
    podRevisionAtDispatch,
    queuedAt: now,
  });

  // Slice 017 Fix 2 — the raw `queued` insert had no announce, so the first
  // `queued` state never wrote a live_outbox row → never propagated live.
  // Announce immediately after the insert (gateway re-reads the post-write row).
  try {
    const queuedBroadcast = deps.broadcast
      ? (event: unknown) => deps.broadcast?.(event as { type: string; [key: string]: unknown })
      : undefined;
    announceAgentRunChange(
      {
        runId: agentRunId,
        reason: 'queued',
        worktreeDir: input.worktreeDir,
        startedAt: now,
      },
      queuedBroadcast,
    );
  } catch {
    /* best-effort */
  }

  // Section 26.6 — point the contract WI at the run that's about to produce
  // its report. Reject (`pc_resolve_work_item` decision="reject") reads this to
  // know which run to wake with feedback. Best-effort: skip if the WI vanished.
  if (workItem?.workItemId) {
    setAssignedAgentRunId(workItem.workItemId, agentRunId);
  }

  const started = await startDispatchedRun({
    input: { ...input, parentWorkItemId: parentWorkItemForRow },
    podName: input.agentName,
    agentRunId,
    ccSessionId,
    scratchDir,
    podPrep,
    podRevisionAtDispatch,
    mode: 'fresh',
    initialInput: input.input,
    continuesParent: null,
    workItemId: workItem?.workItemId ?? null,
    deps,
  });
  if (!started.ok) return started;

  return {
    ok: true,
    agentRunId,
    ccSessionId,
    podName: input.agentName,
    initialState: started.initialState,
    startedAt: now,
  };
}

// ─────────────────────────────── CONTINUATION ────────────────────────────────

/** Plan + construct + register a continuation. The plan step (Session 8's
 *  `continueAgent`) handles all the guards — parent terminal, JSONL on
 *  disk, no concurrent continuation, project exists. */
export async function dispatchContinueAgent(
  input: DispatchContinueAgentInput,
  deps: DispatchAgentDeps,
): Promise<DispatchAgentResult> {
  const now = (deps.now ?? Date.now)();

  const plan = continueAgent(
    {
      parentAgentRunId: input.parentAgentRunId,
      input: input.input,
      now,
    },
    { now: deps.now },
  );
  if (!plan.ok) {
    return {
      ok: false,
      cause: plan.cause,
      error: plan.error,
    } as DispatchAgentFailure;
  }

  // The plan already inserted the agent_runs_v2 row with status='queued'.
  // Now materialise the pod + construct + register + start.
  const scratchDirFn = deps.scratchDirFor ?? defaultScratchDirFor;
  const scratchDir = scratchDirFn(input.projectId, plan.plan.agentRunId);

  try {
    mkdirSync(scratchDir, { recursive: true });
  } catch (err) {
    markAgentRunTerminal({
      id: plan.plan.agentRunId,
      status: 'failed',
      result: null,
      failureCause: 'spawn-error',
      failureReason: `scratchDir mkdir failed: ${(err as Error).message}`,
      completedAt: now,
    });
    return {
      ok: false,
      cause: 'scratch-mkdir-failed',
      error: `scratchDir mkdir failed: ${(err as Error).message}`,
    };
  }

  // Section 26.4 — resolve the contract WI for the continuation. Caller's
  // explicit `workItemId` wins; otherwise carry the parent run's contract
  // forward so the resumed conversation stays anchored to the same WI.
  const continueWorkItemId: ULID | null =
    (input.workItemId as ULID | undefined) ?? plan.plan.parentWorkItemId ?? null;
  let continueWorkItem: { workItemId: ULID; expectedOutput: ExpectedOutput } | null = null;
  if (continueWorkItemId) {
    const wi = getWorkItem(continueWorkItemId);
    if (wi?.expectedOutput) {
      continueWorkItem = { workItemId: continueWorkItemId, expectedOutput: wi.expectedOutput };
    }
    // Soft-fail on archived/unknown — continuations shouldn't break just because
    // the original WI was archived. The resumed agent still has prior context.
  }

  let podPrep: PodSpawnPrep | null = null;
  try {
    podPrep = preparePodSpawn({
      agentName: plan.plan.podName,
      projectId: input.projectId,
      worktreeDir: input.worktreeDir,
      scratchDir,
      filterMcpToReferencedTools: true,
      workItem: continueWorkItem ?? undefined,
    });
  } catch (err) {
    markAgentRunTerminal({
      id: plan.plan.agentRunId,
      status: 'failed',
      result: null,
      failureCause: 'spawn-error',
      failureReason: `pod materialisation failed: ${(err as Error).message}`,
      completedAt: now,
    });
    return {
      ok: false,
      cause: 'pod-materialisation-failed',
      error: `pod materialisation failed for "${plan.plan.podName}": ${(err as Error).message}`,
    };
  }
  if (!podPrep) {
    markAgentRunTerminal({
      id: plan.plan.agentRunId,
      status: 'failed',
      result: null,
      failureCause: 'spawn-error',
      failureReason: `pod "${plan.plan.podName}" no longer in registry`,
      completedAt: now,
    });
    return {
      ok: false,
      cause: 'unknown-agent',
      error: `pod "${plan.plan.podName}" no longer in registry`,
    };
  }

  // Section 26.6 — re-point the contract WI at the continuation run so a
  // subsequent reject wakes the latest producer, not the parent. Skips
  // silently if the WI was archived/unknown above.
  if (continueWorkItemId) {
    setAssignedAgentRunId(continueWorkItemId, plan.plan.agentRunId);
  }

  const started = await startDispatchedRun({
    input: {
      projectId: input.projectId,
      worktreeDir: input.worktreeDir,
      agentName: plan.plan.podName,
      input: input.input,
      dispatcherSessionId: plan.plan.dispatcherSessionId,
      parentWorkItemId: plan.plan.parentWorkItemId,
      invokeDepth: plan.plan.parentInvokeDepth,
      slug: input.slug,
    },
    podName: plan.plan.podName,
    agentRunId: plan.plan.agentRunId,
    ccSessionId: plan.plan.ccSessionId,
    scratchDir,
    podPrep,
    podRevisionAtDispatch: plan.plan.podRevisionAtDispatch,
    mode: 'resume',
    initialInput: input.input,
    continuesParent: input.parentAgentRunId,
    workItemId: continueWorkItemId,
    deps,
  });
  if (!started.ok) return started;

  return {
    ok: true,
    agentRunId: plan.plan.agentRunId,
    ccSessionId: plan.plan.ccSessionId,
    podName: plan.plan.podName,
    initialState: started.initialState,
    startedAt: now,
  };
}

// ─────────────────────────────── CONSTRUCT + REGISTER ────────────────────────

interface ConstructAndStartArgs {
  input: DispatchFreshAgentInput;
  podName: string;
  agentRunId: ULID;
  ccSessionId: string;
  scratchDir: string;
  podPrep: PodSpawnPrep;
  podRevisionAtDispatch: string | null;
  mode: 'fresh' | 'resume';
  initialInput: string;
  continuesParent: ULID | null;
  /** Section 26.4 — the agent's contract WI, if any. Surfaced in the spawn
   *  env via `PC_AGENT_WORK_ITEM_ID` so MCP tools called by the agent (e.g.
   *  `pc_attach_to_work_item`, eventual body/status updaters) can resolve
   *  the assignment without re-parsing the materialised .md. */
  workItemId: ULID | null;
  deps: DispatchAgentDeps;
}

type StartDispatchedRunResult =
  | { ok: true; initialState: 'queued' | 'spawning' }
  | {
      ok: false;
      cause: 'host-unavailable' | 'host-protocol-error';
      error: string;
    };

async function startDispatchedRun(
  args: ConstructAndStartArgs,
): Promise<StartDispatchedRunResult> {
  if (args.deps.hostClient) {
    return startHostBackedRun(args, args.deps.hostClient);
  }

  const run = constructAndStart(args);
  return {
    ok: true,
    initialState: run.getState() === 'spawning' ? 'spawning' : 'queued',
  };
}

async function startHostBackedRun(
  args: ConstructAndStartArgs,
  hostClient: AgentHostReattachClient,
): Promise<StartDispatchedRunResult> {
  const activeReg = args.deps.activeRunRegistry ?? getActiveRunRegistry();
  const commandType = args.mode === 'fresh' ? 'start-run' : 'resume-run';
  const command =
    args.mode === 'fresh'
      ? { type: 'start-run' as const, request: buildHostStartRunRequest(args) }
      : { type: 'resume-run' as const, request: buildHostResumeRunRequest(args) };
  let handle: HostBackedActiveRunHandle | null = null;
  // T1.2 — the OBJ-2A `latestRunStateSnapshot` replay patch is gone. The factory
  // subscribes BELOW before awaiting `sendCommand`, and `hostConnection.onEvent`
  // is fed by ONE ordered `/events` stream (seq-continuous across reconnect), so
  // any `run-state` during the await is delivered in order; after `handle` is
  // assigned, subsequent state events apply directly. The mid-await null window
  // the patch covered no longer leaves a stale seed (proven: host-connection-
  // consumers.test.ts "run-state mid-sendCommand … WITHOUT the … patch").
  let unsubscribe: (() => void) | void;
  const fail = (
    cause: 'host-unavailable' | 'host-protocol-error',
    error: string,
  ): StartDispatchedRunResult => {
    unsubscribe?.();
    return failHostStart(args, cause, error);
  };

  unsubscribe = hostClient.onEvent?.((event) => {
    if (!hostEventBelongsToRun(event, args.agentRunId)) return;
    if (event.type === 'run-terminal') {
      const applied = applyHostTerminalSnapshot(event.run, {
        activeRunRegistry: activeReg,
        broadcast: broadcastForFactory(args),
        mailboxEnqueue: args.deps.mailboxEnqueue,
        verifyOnTerminal: args.deps.verifyOnTerminal,
        verificationDeps: args.deps.verificationDeps,
        terminalCleanup: () => args.podPrep.cleanup(),
        onTerminalError: (err) => {
          console.error(
            `[agent-run-factory] host terminal handler failed for run ${args.agentRunId}:`,
            err,
          );
        },
      });
      handle?.applySnapshot(event.run);
      if (applied > 0) unsubscribe?.();
      return;
    }
    applyAgentHostEvent(event, {
      activeRunRegistry: activeReg,
      broadcast: broadcastForFactory(args),
    });
    if (event.type === 'run-state') {
      if (handle) handle.applySnapshot(event.run);
    }
  });

  let response: AgentHostCommandResponse | void;
  try {
    response = await hostClient.sendCommand(command);
  } catch (err) {
    return fail(
      'host-unavailable',
      `agent host command ${commandType} failed: ${(err as Error).message}`,
    );
  }

  if (!response) {
    return fail(
      'host-protocol-error',
      `agent host command ${commandType} returned no response`,
    );
  }
  if (!response.ok) {
    const cause =
      response.code === 'protocol-error' ? 'host-protocol-error' : 'host-unavailable';
    return fail(cause, `agent host command ${commandType} failed: ${response.error}`);
  }
  if (response.command !== commandType || !('run' in response)) {
    return fail(
      'host-protocol-error',
      `agent host command ${commandType} returned ${response.command}`,
    );
  }

  const snapshot = response.run;
  if (!hostSnapshotMatchesDispatch(args, snapshot)) {
    return fail(
      'host-protocol-error',
      'agent host start response did not match the dispatched run',
    );
  }

  handle = new HostBackedActiveRunHandle(snapshot, hostClient, {
    onCommandError: (error, command) => {
      console.warn(
        `[agent-run-factory] host command ${command.type} failed for run ${args.agentRunId}: ${error.message}`,
      );
    },
  });
  activeReg.register({
    run: handle,
    projectId: args.input.projectId,
    dispatcherSessionId: args.input.dispatcherSessionId,
    ccSessionId: args.ccSessionId,
    podName: args.podName,
    parentWorkItemId: args.input.parentWorkItemId ?? null,
    podRevisionAtDispatch: args.podRevisionAtDispatch,
  });

  if (isTerminalHostState(snapshot.state)) {
    applyHostTerminalSnapshot(snapshot, {
      activeRunRegistry: activeReg,
      broadcast: broadcastForFactory(args),
      mailboxEnqueue: args.deps.mailboxEnqueue,
      verifyOnTerminal: args.deps.verifyOnTerminal,
      verificationDeps: args.deps.verificationDeps,
      terminalCleanup: () => args.podPrep.cleanup(),
      onTerminalError: (err) => {
        console.error(
          `[agent-run-factory] host terminal handler failed for run ${args.agentRunId}:`,
          err,
        );
      },
    });
  } else {
    updateAgentRunStatus({
      id: args.agentRunId,
      status: snapshot.state,
      ...(snapshot.spawnedAt !== null ? { spawnedAt: snapshot.spawnedAt } : {}),
      ...(snapshot.readyAt !== null ? { readyAt: snapshot.readyAt } : {}),
    });
    broadcastHostRunChanged(args, snapshot);
  }

  return {
    ok: true,
    initialState: snapshot.state === 'queued' ? 'queued' : 'spawning',
  };
}

function buildHostStartRunRequest(args: ConstructAndStartArgs): AgentHostStartRunRequest {
  return {
    runId: args.agentRunId,
    projectId: args.input.projectId,
    dispatcherSessionId: args.input.dispatcherSessionId,
    ccSessionId: args.ccSessionId,
    podDefinition: {
      name: args.podPrep.agentCliName,
      logicalName: args.podName,
    },
    worktreePath: args.input.worktreeDir,
    env: buildAgentEnv(args),
    initialInput: args.initialInput,
    mcpConfigPath: args.podPrep.mcpConfigPath,
    settingsPath: args.podPrep.settingsPath,
    settingSources: args.podPrep.settingSources,
    pluginDirs: [args.podPrep.pluginDir],
    transcriptPath: transcriptPathFor(args),
  };
}

function buildHostResumeRunRequest(args: ConstructAndStartArgs): AgentHostResumeRunRequest {
  return {
    ...buildHostStartRunRequest(args),
    mode: 'resume',
    continues: args.continuesParent as ULID,
  };
}

function buildAgentEnv(args: ConstructAndStartArgs): Record<string, string> {
  const baseEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...args.podPrep.extraEnv,
    PC_AGENT_NAME: args.podName,
    PC_AGENT_SESSION_ID: args.ccSessionId,
    PC_AGENT_RUN_ID: args.agentRunId,
    PC_DISPATCHER_SESSION_ID: args.input.dispatcherSessionId,
    PC_PROJECT_ID: args.input.projectId,
    PC_AGENT_INVOKE_DEPTH: String(args.input.invokeDepth),
  };
  if (args.input.parentWorkItemId) {
    baseEnv.PC_AGENT_PARENT_WORK_ITEM_ID = args.input.parentWorkItemId;
  }
  if (args.workItemId) {
    baseEnv.PC_AGENT_WORK_ITEM_ID = args.workItemId;
  }
  return baseEnv;
}

function transcriptPathFor(args: ConstructAndStartArgs): string {
  return resolve(args.scratchDir, 'transcript.log');
}

function failHostStart(
  args: ConstructAndStartArgs,
  cause: 'host-unavailable' | 'host-protocol-error',
  error: string,
): StartDispatchedRunResult {
  const completedAt = (args.deps.now ?? Date.now)();
  markAgentRunTerminal({
    id: args.agentRunId,
    status: 'failed',
    result: null,
    failureCause: cause,
    failureReason: error,
    completedAt,
  });
  args.podPrep.cleanup();
  broadcastAgentRunChanged(args, 'failed');
  return { ok: false, cause, error };
}

function broadcastForFactory(
  args: ConstructAndStartArgs,
): ((projectId: ULID, msg: unknown) => void) | undefined {
  if (!args.deps.broadcast) return undefined;
  return (projectId, msg) => {
    if (projectId !== args.input.projectId) return;
    args.deps.broadcast?.(msg as { type: string; [key: string]: unknown });
  };
}

function broadcastHostRunChanged(
  args: ConstructAndStartArgs,
  snapshot: AgentHostRunSnapshot,
): void {
  broadcastAgentRunChanged(args, snapshot.state);
}

/** Slice 005 — host-mode broadcast now routes through the gateway, which
 *  re-reads the POST-write row for the correct rev (closes the host-mode
 *  stale-rev issue: the record used to be built from a pre-update row). */
function broadcastAgentRunChanged(
  args: ConstructAndStartArgs,
  status: AgentHostRunSnapshot['state'],
): void {
  // Slice 017 Fix 2 — the durable announce (writes the live_outbox row) must
  // never depend on the in-memory broadcast hook. factoryBroadcast(args)
  // returns undefined when no hook; the legacy fanout tolerates undefined.
  const reason = hostStateToReason(status);
  try {
    announceAgentRunChange(
      {
        runId: args.agentRunId,
        reason,
        worktreeDir: args.input.worktreeDir,
        startedAt: (args.deps.now ?? Date.now)(),
      },
      factoryBroadcast(args),
    );
  } catch {
    /* best-effort */
  }
}

/** Adapt the factory's `(env) => void` broadcast hook to the writer's
 *  `(event: unknown) => void` shape. */
function factoryBroadcast(args: ConstructAndStartArgs): ((event: unknown) => void) | undefined {
  const b = args.deps.broadcast;
  if (!b) return undefined;
  return (event: unknown) => b(event as { type: string; [key: string]: unknown });
}

function hostStateToReason(state: AgentHostRunSnapshot['state']): AgentRunChangedReason {
  switch (state) {
    case 'queued':
    case 'spawning':
    case 'running':
    case 'paused':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return state;
    default:
      return 'reconciled';
  }
}

function hostEventBelongsToRun(
  event: AgentHostEvent,
  runId: ULID,
): boolean {
  if (event.type === 'run-state' || event.type === 'run-terminal') {
    return event.run.runId === runId;
  }
  if (event.type === 'run-jsonl' || event.type === 'run-chunk' || event.type === 'run-error') {
    return event.runId === runId;
  }
  return false;
}

function hostSnapshotMatchesDispatch(
  args: ConstructAndStartArgs,
  snapshot: AgentHostRunSnapshot,
): boolean {
  return (
    snapshot.runId === args.agentRunId &&
    snapshot.projectId === args.input.projectId &&
    snapshot.dispatcherSessionId === args.input.dispatcherSessionId &&
    snapshot.ccSessionId === args.ccSessionId &&
    snapshot.podName === args.podName
  );
}

function isTerminalHostState(
  state: AgentHostRunSnapshot['state'],
): state is 'completed' | 'failed' | 'cancelled' {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function constructAndStart(args: ConstructAndStartArgs): AgentRun {
  const reg = args.deps.runRegistry ?? getRunRegistry();
  const activeReg = args.deps.activeRunRegistry ?? getActiveRunRegistry();
  const factory = args.deps.agentRunFactory ?? defaultAgentRunFactory;

  // Env contract: dispatched agents get the agent-run env vars + the project
  // gate + the dispatcher session-id forwarded for routing pause emits back.
  // Parallel-build invariant: PC_AGENT_SESSION_ID still = ccSessionId (v1
  // contract preserved) so v1 tools called from the spawned agent also work.
  // Phase D rip target: design § 11.1 wants PC_AGENT_SESSION_ID = agent_run_id.
  const baseEnv = buildAgentEnv(args);

  const run = factory({
    agentRunId: args.agentRunId,
    ccProviderSessionId: args.ccSessionId,
    podDefinition: { name: args.podPrep.agentCliName, logicalName: args.podName },
    worktreePath: args.input.worktreeDir,
    env: baseEnv,
    initialInput: args.mode === 'fresh' ? args.initialInput : args.initialInput,
    mode: args.mode,
    continues: args.continuesParent ?? undefined,
    mcpConfigPath: args.podPrep.mcpConfigPath,
    settingsPath: args.podPrep.settingsPath,
    settingSources: args.podPrep.settingSources,
    pluginDirs: [args.podPrep.pluginDir],
    // Forensic transcript per spawn — sits next to the materialised pod files
    // in the per-run scratch dir.
    transcriptPath: transcriptPathFor(args),
    registry: reg,
  });

  // Register with the active-runs index so pause-resume can find the run by
  // id or by cc-session.
  activeReg.register({
    run: activeRunHandleForAgentRun(run),
    projectId: args.input.projectId,
    dispatcherSessionId: args.input.dispatcherSessionId,
    ccSessionId: args.ccSessionId,
    podName: args.podName,
    parentWorkItemId: args.input.parentWorkItemId ?? null,
    podRevisionAtDispatch: args.podRevisionAtDispatch,
  });

  // Session 10 — Activity Panel adapter shim. Slice 005: the durable fact is
  // recorded through the AgentRunMutationGateway (one live_outbox row, correct
  // post-write rev), then fanned out canonical + legacy. The DB status write
  // already happened on each transition below; this re-reads + announces.
  const startedAt = (args.deps.now ?? Date.now)();
  const broadcastStateChanged = (
    status: 'queued' | 'spawning' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled',
  ): void => {
    // Slice 017 Fix 2 — durable announce always fires (broadcast hook is an
    // optional fanout, not a gate on the live_outbox write).
    try {
      announceAgentRunChange(
        {
          runId: args.agentRunId,
          reason: status,
          worktreeDir: args.input.worktreeDir,
          startedAt,
        },
        factoryBroadcast(args),
      );
    } catch {
      /* best-effort */
    }
  };

  // Persist the spawned OS pid so the liveness sweep can probe process
  // existence and hard-kill can target the real process. Idempotent; no-ops
  // until the spawn child exists (run.getPid() returns null pre-spawn).
  const persistPid = (): void => {
    const pid = run.getPid();
    if (pid !== null) updateAgentRunPid(args.agentRunId, pid);
  };

  // Fire initial 'queued' envelope so the panel renders the card the moment
  // the row lands. State events from AgentRun only fire on TRANSITIONS, not
  // the initial state, so we emit explicitly here.
  broadcastStateChanged('queued');

  // Persist state-machine transitions. AgentRun emits `state(next, prev)` on
  // every move; we mirror queued→spawning/running/paused to the DB row +
  // broadcast a panel envelope.
  run.on('state', (next: string) => {
    if (next === 'spawning') {
      updateAgentRunStatus({
        id: args.agentRunId,
        status: 'spawning',
        spawnedAt: Date.now(),
      });
      // The child may not exist yet at the spawning edge (spawn is created
      // inside runSpawnPhase); capture opportunistically and again at running.
      persistPid();
      broadcastStateChanged('spawning');
    } else if (next === 'running') {
      const at = Date.now();
      updateAgentRunStatus({
        id: args.agentRunId,
        status: 'running',
        readyAt: at,
      });
      // Definitive pid capture — the spawn child exists once we're ready, and
      // baseline the activity clock so the liveness sweep has a starting point.
      persistPid();
      touchAgentRunActivity(args.agentRunId, at);
      broadcastStateChanged('running');
    } else if (next === 'paused') {
      broadcastStateChanged('paused');
    }
  });

  // Phase D — Activity Panel live-transcript modal subscribes to
  // `agent-jsonl-event` envelopes filtered by runId. Fan every JSONL event
  // out via the broadcast dep so the panel sees the same surface v1 produced.
  run.on('jsonl-event', (event: unknown) => {
    // Liveness signal for the reconcile sweep: every JSONL event = the run is
    // making progress. Stamp before the (optional) broadcast so activity is
    // recorded even when no broadcast dep is wired (tests).
    touchAgentRunActivity(args.agentRunId, Date.now());
    if (!args.deps.broadcast) return;
    try {
      args.deps.broadcast({
        type: 'agent-jsonl-event',
        runId: args.agentRunId,
        event,
      });
    } catch {
      /* best-effort */
    }
  });

  // Phase D — emit an `agent-queued-started` envelope to the dispatcher's
  // mailbox when a previously-queued dispatch actually fires.
  run.on('queued-started', () => {
    const startedAt = Date.now();
    const mailboxEnqueue = args.deps.mailboxEnqueue;
    if (!mailboxEnqueue) return;
    deliverAgentEnvelope(
      {
        projectId: args.input.projectId,
        pcSessionId: args.input.dispatcherSessionId,
        kind: 'agent-queued-started' as AgentInboxEventKind,
        slug: args.input.slug,
        source: 'agent',
        body: buildAgentQueuedStartedBody({
          runId: args.agentRunId,
          sessionId: args.ccSessionId,
          agentName: args.podName,
          parentWorkItemId: args.input.parentWorkItemId ?? null,
          queuedAt: startedAt,
          startedAt,
        }),
        sender: 'pc',
        idempotencyKey: `agent:${args.agentRunId}:agent-queued-started`,
        sourceId: args.agentRunId,
      },
      { mailboxEnqueue },
    );
  });

  // Terminal handling: persist row + run tier-1 verification (Section 26.5) +
  // emit channel envelope to dispatcher + emit Activity Panel envelope.
  run.once(
    'terminal',
    (info: { status: 'completed' | 'failed' | 'cancelled'; cause?: string; result?: string }) => {
      applyAgentRunTerminalEffects(
        {
          runId: args.agentRunId,
          ccSessionId: args.ccSessionId,
          podName: args.podName,
          projectId: args.input.projectId,
          dispatcherSessionId: args.input.dispatcherSessionId,
          parentWorkItemId: args.input.parentWorkItemId ?? null,
          worktreeDir: args.input.worktreeDir,
          status: info.status,
          result: info.result ?? '',
          failureCause: info.cause ?? null,
          completedAt: Date.now(),
          startedAt,
          workItemId: args.workItemId,
          slug: args.input.slug,
          cleanup: () => args.podPrep.cleanup(),
        },
        {
          activeRunRegistry: activeReg,
          mailboxEnqueue: args.deps.mailboxEnqueue ?? null,
          broadcast: (_projectId, msg) => {
            args.deps.broadcast?.(msg as { type: string; [key: string]: unknown });
          },
          verifyOnTerminal: args.deps.verifyOnTerminal,
          verificationDeps: args.deps.verificationDeps,
          onError: (err) => {
            console.error(
              `[agent-run-factory] terminal handler failed for run ${args.agentRunId}:`,
              err,
            );
          },
        },
      );
    },
  );

  run.start();
  return run;
}

// ─────────────────────────────── DEFAULT FACTORY ─────────────────────────────

function defaultAgentRunFactory(
  input: ConstructorParameters<typeof AgentRun>[0] & {
    registry: AgentRunRegistry;
  },
): AgentRun {
  const { registry, ...runInput } = input;
  return new AgentRun(runInput, { registry });
}

function defaultScratchDirFor(projectId: ULID, agentRunId: ULID): string {
  const root = process.env.PC_DATA_DIR ?? 'data';
  return resolve(root, 'projects', projectId, 'agent-runs-v2', agentRunId);
}

// Tiny export shim so callers can construct a `Record` of the run's current
// snapshot without importing `AgentRun` directly.
export function snapshotAgentRun(run: AgentRun): AgentRunRecord {
  return run.getRecord();
}
