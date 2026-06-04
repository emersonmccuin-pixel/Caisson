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
  listContractsForWorkItem,
  markAgentRunTerminal,
  newId,
  setAgentRunContractId,
  updateAgentRunStatus,
} from '@pc/db';
import { ContractService } from '@pc/app-services';
import { ContractV2, expectedOutputRequiresWorkItem } from '@pc/domain';
import type {
  AgentRunFailureCause,
  ExpectedOutput,
  ULID,
} from '@pc/domain';
import type { AgentRunChangedReason } from '@pc/contracts';
import {
  jsonlPathFor,
  type AgentHostCommandResponse,
  type AgentHostResumeRunRequest,
  type AgentHostRunSnapshot,
  type AgentHostStartRunRequest,
} from '@pc/runtime';

import { type VerificationBlock } from './agent-event-header.ts';
import { preparePodSpawn, type PodSpawnPrep } from './pod-spawn.ts';

import {
  getActiveRunRegistry,
  HostBackedActiveRunHandle,
  type ActiveRunRegistry,
} from './agent-active-runs.ts';
import {
  applyHostTerminalSnapshot,
  type AgentHostReattachClient,
} from './agent-host-reattach.ts';
import { type MailboxEnqueuePort } from './agent-delivery.ts';
import { continueAgent, type ContinueAgentResult } from './pause-resume.ts';
import {
  runVerificationOnTerminal,
  type VerificationDeps,
} from './agent-verification.ts';
import { announceAgentRunChange } from './agent-run-writer.ts';

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
  /** Slice 019 (contract-first) — the dispatch's own v2 expected-output spec,
   *  authored directly onto the contract (wins over a linked WI's legacy
   *  columns). Optional: legacy WI-sourced dispatches omit it and the contract
   *  falls back to the WI's columns. */
  expectedOutput?: Parameters<ContractService['create']>[0]['expectedOutput'];
  /** Caller's nesting depth + 1. The orchestrator dispatches at depth 1; an
   *  agent dispatched by that one runs at depth 2. */
  invokeDepth: number;
  /** Project slug — embedded in delivery envelopes so the orchestrator can
   *  pin a channel POST back to its source project. */
  slug: string;
  /** Door-unification — extra spawn-env vars merged on top of the pod's env,
   *  BELOW the PC_AGENT_* core (which always wins). The workflow engine passes
   *  `PC_WORKFLOW_RUN_ID` + `PC_WORKFLOW_WORKTREE` here so path-guard.cjs
   *  enforces worktree confinement for workflow-node agents. The orchestrator
   *  omits it. */
  extraEnv?: Record<string, string>;
  /** Door-unification — per-dispatch idle-timeout override (ms). The workflow
   *  engine forwards a node's `timeout`. Omitted = the AgentRun default (5min).*/
  idleMs?: number;
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
  /** Inject for tests. Defaults to the process-wide singleton. */
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
  /** Slice 013 — first-class contract write door. Used to resolve/create the
   *  contract for a contract dispatch + link the run to it. Defaults to a fresh
   *  `ContractService` (live DB); tests may inject one or leave it to skip the
   *  contract link (no-op when no contract WI is dispatched). */
  contractService?: ContractService;
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

/** Door-unification — the post-verification terminal facts surfaced through the
 *  `done` promise. The orchestrator ignores `done`; the workflow engine awaits
 *  it and maps it to a DAG NodeOutcome. */
export interface TerminalOutcome {
  agentRunId: ULID;
  status: 'completed' | 'failed' | 'cancelled';
  failureCause: AgentRunFailureCause | null;
  failureReason: string | null;
  result: string;
  /** Contract verification result, when the run had a contract + the verifier
   *  ran. NULL for non-contract dispatches or a cancelled run. The workflow
   *  treats `status: 'failed'` as a failed node. */
  verification: VerificationBlock | null;
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
  /** Resolves when the run reaches terminal AND verification has flipped the
   *  contract. Fire-and-forget callers (orchestrator) ignore it; the workflow
   *  engine awaits it. Resolves exactly once. */
  done: Promise<TerminalOutcome>;
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
      cause: 'work-item-required';
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
  const activeReg = deps.activeRunRegistry ?? getActiveRunRegistry();

  // The `done` promise the workflow engine awaits. Resolved exactly once by the
  // ONE terminal authority through a run-keyed settlement waiter on the
  // ActiveRunRegistry (registered just before start, below) — NOT by a per-run
  // host-event listener. That keys done-resolution to the run id, so it no
  // longer depends on which listener / reconcile sweep wins the terminal race.
  let resolveDone!: (outcome: TerminalOutcome) => void;
  const done = new Promise<TerminalOutcome>((res) => {
    resolveDone = res;
  });

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

  // Slice 019 (Decision 4) — reject loudly when the dispatch's own output spec
  // needs a work-item home and none is attached. The orchestrator must attach
  // an existing work item or create one first. Only fires for contract-first
  // dispatches that author an `expectedOutput` inline; legacy WI-sourced
  // dispatches (no inline spec) skip this and source from the WI as before.
  const inlineSpec = input.expectedOutput;
  if (
    inlineSpec &&
    ContractV2.isExpectedOutputKind((inlineSpec as { kind?: unknown }).kind) &&
    expectedOutputRequiresWorkItem(inlineSpec as ContractV2.ExpectedOutput) &&
    !input.workItemId
  ) {
    return {
      ok: false,
      cause: 'work-item-required',
      error: `expected_output kind "${(inlineSpec as { kind: string }).kind}" must land in a work item — attach one via workItemId or create one before dispatching`,
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

  // Resolve the optional linked work item. The materialiser writes a
  // "## Your contract" section into the rendered .md when this is non-null,
  // surfacing the contract's expected output + pointing at the linked WI. The
  // expected output is the contract spec (`input.expectedOutput`), NOT a WI
  // column (those were dropped in slice 023). Hard-fail on an unknown/archived
  // linked id — the orchestrator can't attach against a phantom WI.
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
    if (!input.expectedOutput) {
      return {
        ok: false,
        cause: 'pod-materialisation-failed',
        error: `dispatch attached to workItem "${input.workItemId}" has no expected_output`,
      };
    }
    workItem = {
      workItemId: input.workItemId,
      expectedOutput: input.expectedOutput as ExpectedOutput,
    };
  }

  let podPrep: PodSpawnPrep | null = null;
  try {
    podPrep = preparePodSpawn({
      agentName: input.agentName,
      projectId: input.projectId,
      worktreeDir: input.worktreeDir,
      scratchDir,
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

  // Resolve (or create) the first-class contract for this dispatch + link the
  // run to it. Prefer an existing agent_contracts row for the linked WI, else
  // create one from the dispatch's explicit spec. The run↔contract link
  // (agent_runs.contract_id) is the spine; the reject path resolves the
  // producer run from contract.agentRunId.
  const contractId = resolveContractForDispatch({
    projectId: input.projectId,
    workItemId: workItem?.workItemId ?? null,
    agentRunId,
    podName: input.agentName,
    contractService: deps.contractService,
    expectedOutput: input.expectedOutput,
  });

  // Register the run-keyed settlement waiter BEFORE start so a terminal applied
  // synchronously in the start response (or by the persistent host-event
  // listener during the await) resolves `done`.
  activeReg.onSettled(agentRunId, (s) => resolveDone({ agentRunId, ...s }));

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
    contractId,
    deps,
  });
  if (!started.ok) {
    // Start failed before the run could ever reach terminal — `done` is
    // discarded; drop the waiter so it doesn't leak in the registry.
    activeReg.cancelSettlement(agentRunId);
    return started;
  }

  return {
    ok: true,
    agentRunId,
    ccSessionId,
    podName: input.agentName,
    initialState: started.initialState,
    startedAt: now,
    done,
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
  const activeReg = deps.activeRunRegistry ?? getActiveRunRegistry();

  // The `done` promise — resolved by the one terminal authority via a run-keyed
  // settlement waiter (registered just before start, below). Symmetric with the
  // fresh path so both dispatch shapes return an awaitable terminal.
  let resolveDone!: (outcome: TerminalOutcome) => void;
  const done = new Promise<TerminalOutcome>((res) => {
    resolveDone = res;
  });

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
    // Source the expected output from the linked contract (slice 023 dropped the
    // WI contract columns). Soft-fail when no contract/WI is found — a
    // continuation shouldn't break; the resumed agent still has prior context.
    const wi = getWorkItem(continueWorkItemId);
    if (wi) {
      const contractSvc = deps.contractService ?? new ContractService();
      const linked = contractSvc.listByWorkItem(continueWorkItemId).slice(-1)[0] ?? null;
      if (linked?.expectedOutput) {
        continueWorkItem = {
          workItemId: continueWorkItemId,
          expectedOutput: linked.expectedOutput as ExpectedOutput,
        };
      }
    }
  }

  let podPrep: PodSpawnPrep | null = null;
  try {
    podPrep = preparePodSpawn({
      agentName: plan.plan.podName,
      projectId: input.projectId,
      worktreeDir: input.worktreeDir,
      scratchDir,
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

  // Re-link the contract to the continuation run (same resolution as the fresh
  // path). The contract carries retries on its `attempt` field; this keeps the
  // run↔contract link pointed at the latest producer.
  const contractId = resolveContractForDispatch({
    projectId: input.projectId,
    workItemId: continueWorkItemId,
    agentRunId: plan.plan.agentRunId,
    podName: plan.plan.podName,
    contractService: deps.contractService,
  });

  // Register the run-keyed settlement waiter BEFORE start (see fresh path).
  activeReg.onSettled(plan.plan.agentRunId, (s) =>
    resolveDone({ agentRunId: plan.plan.agentRunId, ...s }),
  );

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
    contractId,
    deps,
  });
  if (!started.ok) {
    activeReg.cancelSettlement(plan.plan.agentRunId);
    return started;
  }

  return {
    ok: true,
    agentRunId: plan.plan.agentRunId,
    ccSessionId: plan.plan.ccSessionId,
    podName: plan.plan.podName,
    initialState: started.initialState,
    startedAt: now,
    done,
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
  /** Slice 013 — the first-class contract this run produces (resolved at
   *  dispatch). NULL for non-contract dispatches. Threaded to terminal-effects
   *  so the deliverable lands on the contract. */
  contractId: ULID | null;
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
  // P2 (ledger row 3) — the host-backed spawn is the ONE spawn path. The
  // in-process fallback (`constructAndStart`) was dead in any real server
  // (index.ts always wires a host connection) and is DELETED. No host wired =
  // a typed failure on the row, never a silent alternate spawn.
  if (!args.deps.hostClient) {
    return failHostStart(
      args,
      'host-unavailable',
      'no agent host connection wired — the host-backed spawn is the only spawn path',
    );
  }
  return startHostBackedRun(args, args.deps.hostClient);
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
  // ONE terminal authority. This dispatch does NOT subscribe a per-run host-event
  // listener — that was the rival in the double-subscribe race that starved the
  // workflow `done`. Run-terminal / run-state for this run flow through the
  // persistent boot host-event listener (and the watchdog reconcile sweep), which
  // finalize the row via applyAgentRunTerminalEffects AND fire the run-keyed
  // settlement waiter the dispatch registered on the ActiveRunRegistry. A
  // terminal returned synchronously in the start response is applied below.
  let handle: HostBackedActiveRunHandle | null = null;
  const fail = (
    cause: 'host-unavailable' | 'host-protocol-error',
    error: string,
  ): StartDispatchedRunResult => failHostStart(args, cause, error);

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
    // Authoritative JSONL path computed with the SERVER's normalized env (the
    // same CLAUDE_CONFIG_DIR the spawned agent inherits via buildAgentEnv). The
    // host must NOT recompute this from its own env, or the two can diverge and
    // the host tails a folder the agent never writes to → false idle-timeout.
    jsonlPath: jsonlPathFor(args.input.worktreeDir, args.ccSessionId),
    // Door-unification — per-dispatch idle-timeout override (workflow node
    // `timeout`). Omitted = host AgentRun default.
    ...(args.input.idleMs !== undefined ? { timeouts: { idleMs: args.input.idleMs } } : {}),
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
    // Door-unification — caller-supplied spawn env (workflow PC_WORKFLOW_*),
    // merged BELOW the PC_AGENT_* core so the core always wins.
    ...(args.input.extraEnv ?? {}),
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

// ☠ P2 (ledger row 3, 2026-06-03) — `constructAndStart` + `defaultAgentRunFactory`
// (the in-process spawn fallback) DELETED. The agent host owns every spawn;
// no hostClient = typed `host-unavailable` failure in startDispatchedRun.

function defaultScratchDirFor(projectId: ULID, agentRunId: ULID): string {
  const root = process.env.PC_DATA_DIR ?? 'data';
  return resolve(root, 'projects', projectId, 'agent-runs-v2', agentRunId);
}

/** Slice 013 — resolve (or create) the first-class contract for a dispatch +
 *  link the run to it. Read-through shim:
 *   1. No contract WI → no contract (returns null).
 *   2. An `agent_contracts` row already exists for the WI (backfilled, or
 *      created at `pc_create_agent_work_item` time) → reuse the latest one.
 *   3. Otherwise (un-backfilled legacy WI) → create one from the WI's legacy
 *      contract columns so the run still has a contract home.
 *  Then point the contract at the run (`dispatched`) AND stamp
 *  `agent_runs.contract_id`. Best-effort: never blocks the dispatch — a failure
 *  here leaves the legacy WI path (verification) untouched. */
/** Deps seam (ESM named exports can't be redefined by node:test) — tests inject
 *  fakes; production defaults to the real repo functions. */
export interface ResolveContractForDispatchDeps {
  getWorkItem?: typeof getWorkItem;
  listContractsForWorkItem?: typeof listContractsForWorkItem;
  setAgentRunContractId?: typeof setAgentRunContractId;
}

/** Slice 019 (contract-first) — resolve the dispatch's contract. ALWAYS returns
 *  a contract: it reuses an open contract on the attached work item when one
 *  exists, else creates a fresh one — with or without a work item. (The old
 *  `!workItemId → null` gate, which made "no WI ⇒ no contract", is gone: the
 *  contract is the spine now.) An explicit v2 `expectedOutput`/AC wins over the
 *  linked WI's legacy columns (the WI fallback survives until dispatch authors
 *  v2 specs everywhere — 021/023). */
export function resolveContractForDispatch(
  args: {
    projectId: ULID;
    workItemId: ULID | null;
    agentRunId: ULID;
    podName: string;
    contractService?: ContractService;
    expectedOutput?: Parameters<ContractService['create']>[0]['expectedOutput'];
    acceptanceCriteria?: Parameters<ContractService['create']>[0]['acceptanceCriteria'];
    verificationTier?: Parameters<ContractService['create']>[0]['verificationTier'];
    worktreePath?: string | null;
  },
  deps: ResolveContractForDispatchDeps = {},
): ULID | null {
  const service = args.contractService ?? new ContractService();
  const listForWi = deps.listContractsForWorkItem ?? listContractsForWorkItem;
  const setRunContract = deps.setAgentRunContractId ?? setAgentRunContractId;
  try {
    let contractId: ULID | null = null;
    // Reuse an existing contract ONLY when this dispatch is attached to a WI.
    if (args.workItemId) {
      const existing = listForWi(args.workItemId);
      if (existing.length > 0) {
        // Prefer an un-dispatched contract; else the most recently created.
        const open = existing.find((c) => c.agentRunId === null);
        contractId = (open ?? existing[existing.length - 1]!).id;
      }
    }
    if (!contractId) {
      // Contract-first: create a contract whether or not a WI is attached.
      // The explicit spec is the only source (the legacy WI contract columns
      // were dropped in slice 023).
      const created = service.create({
        projectId: args.projectId,
        workItemId: args.workItemId,
        podName: args.podName,
        expectedOutput: args.expectedOutput ?? null,
        acceptanceCriteria: args.acceptanceCriteria ?? null,
        verificationTier: args.verificationTier ?? null,
        worktreePath: args.worktreePath ?? null,
      });
      contractId = created.id as ULID;
    }
    if (contractId) {
      service.setRun(contractId, args.agentRunId);
      setRunContract(args.agentRunId, contractId);
    }
    return contractId;
  } catch (err) {
    console.error(
      `[agent-run-factory] contract resolution failed for run ${args.agentRunId}:`,
      err,
    );
    return null;
  }
}