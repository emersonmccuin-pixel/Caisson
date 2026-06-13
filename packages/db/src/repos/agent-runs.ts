// Section 25 — agent_runs repo.
//
// Persists the FULL state machine (queued | spawning | running | paused |
// completed | failed | cancelled). Restart-time reconciliation is a SELECT *
// WHERE status IN ('queued','spawning','running','paused') — no in-memory
// state to lose.
//
// Continuation lineage via `continues` self-FK. `findActiveContinuation`
// guards `pc_continue_agent` against double-continuation of the same parent.

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import type {
  AgentRunFailureCause,
  AgentRunRow,
  AgentRunStatus,
  ULID,
} from '@pc/domain';

import { getDb } from '../connection.ts';
import { agentRuns } from '../schema-agent-system.ts';

export interface InsertAgentRunRowInput {
  /** PC-minted ULID. Matches the AgentRun wrapper's `agentRunId`. */
  id: ULID;
  projectId: ULID;
  podName: string;
  dispatcherSessionId: string;
  ccSessionId: string;
  /** Initial status. Usually `'queued'` at admission time; a downstream
   *  caller flips it to `'spawning'` when the cap frees. */
  status: AgentRunStatus;
  input: string | null;
  parentWorkItemId?: ULID | null;
  parentInvokeDepth?: number;
  /** Null for original dispatches; FK to parent row for continuations. */
  continues?: ULID | null;
  /** Pod row's `updated_at` (or revision hash) at dispatch time. Stored for
   *  drift detection on resume. Null when the materialiser didn't supply a
   *  revision. */
  podRevisionAtDispatch?: string | null;
  /** Slice 013 — FK to the first-class `agent_contracts` row this run is
   *  producing. NULL for legacy/non-contract dispatches. */
  contractId?: ULID | null;
  /** Absolute path to the worktree directory the agent was spawned in. Used to
   *  derive the correct CC JSONL path. NULL = main project dir (legacy rows). */
  worktreeDir?: string | null;
  queuedAt: number;
}

/** Insert a fresh row. Status starts at the caller's choice (typically
 *  'queued'); subsequent transitions go through `updateAgentRunStatus` +
 *  `markAgentRunTerminal`. */
export function insertAgentRunRow(input: InsertAgentRunRowInput): AgentRunRow {
  const row: AgentRunRow = {
    id: input.id,
    projectId: input.projectId,
    dispatcherSessionId: input.dispatcherSessionId,
    ccSessionId: input.ccSessionId,
    podName: input.podName,
    podRevisionAtDispatch: input.podRevisionAtDispatch ?? null,
    podRevisionAtResume: null,
    status: input.status,
    continues: input.continues ?? null,
    parentInvokeDepth: input.parentInvokeDepth ?? 0,
    parentWorkItemId: input.parentWorkItemId ?? null,
    input: input.input,
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: input.queuedAt,
    spawnedAt: null,
    readyAt: null,
    pid: null,
    lastActivityAt: null,
    deliveredAt: null,
    completedAt: null,
    rev: 0,
    contractId: input.contractId ?? null,
    worktreeDir: input.worktreeDir ?? null,
  };
  getDb().insert(agentRuns).values(row).run();
  return row;
}

export interface UpdateAgentRunStatusInput {
  id: ULID;
  status: AgentRunStatus;
  /** Set when transitioning into 'spawning' (or 'spawning' from 'paused' on
   *  resume — both paths re-arm the spawn timestamp). */
  spawnedAt?: number;
  /** Set when transitioning into 'running'. */
  readyAt?: number;
  /** Host-backed runs (2026-06-10): OS pid of the live claude.exe child from
   *  the host snapshot (null after exit). Persisted so peek/kill can answer
   *  "is anything actually alive" — host runs used to always show pid null. */
  pid?: number | null;
  /** Set on the resume path (paused → spawning). Captures pod-row revision
   *  at resume time for drift detection. */
  podRevisionAtResume?: string | null;
}

const REV_INC = sql`rev + 1` as unknown as number;

/** Non-terminal status transition. Idempotent at the row level — caller is
 *  responsible for ordering. */
export function updateAgentRunStatus(input: UpdateAgentRunStatusInput): void {
  const patch: Partial<AgentRunRow> = { status: input.status, rev: REV_INC };
  if (input.spawnedAt !== undefined) patch.spawnedAt = input.spawnedAt;
  if (input.readyAt !== undefined) patch.readyAt = input.readyAt;
  if (input.pid !== undefined) patch.pid = input.pid;
  if (input.podRevisionAtResume !== undefined) {
    patch.podRevisionAtResume = input.podRevisionAtResume;
  }
  getDb().update(agentRuns).set(patch).where(eq(agentRuns.id, input.id)).run();
}

/** Persist the spawned OS pid for an in-process run. Called once right after
 *  the PTY child spawns. Does NOT bump rev — pid is liveness bookkeeping, not a
 *  status transition the frontend needs to version. */
export function updateAgentRunPid(id: ULID, pid: number | null): void {
  getDb().update(agentRuns).set({ pid }).where(eq(agentRuns.id, id)).run();
}

/** Stamp last-observed JSONL activity. Called by the tailer on each event so
 *  the liveness sweep can distinguish a working run from a wedged one. No rev
 *  bump (high-frequency, not a status change). */
export function touchAgentRunActivity(id: ULID, at: number): void {
  getDb().update(agentRuns).set({ lastActivityAt: at }).where(eq(agentRuns.id, id)).run();
}

/** T2.2 — bump rev with NO state change, returning the post-bump row. The
 *  watchdog's non-terminal `stalled` signal carries no status change, so it
 *  would otherwise reuse the last frame's rev and be dropped by the client live
 *  store's version dedup. A rev bump lets the stalled (and un-stall) frame
 *  out-version the prior frame and land. */
export function bumpAgentRunRev(id: ULID): AgentRunRow | null {
  getDb().update(agentRuns).set({ rev: REV_INC }).where(eq(agentRuns.id, id)).run();
  return getAgentRunRow(id);
}

export interface MarkAgentRunTerminalInput {
  id: ULID;
  status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled'>;
  result: string | null;
  failureCause: AgentRunFailureCause | null;
  failureReason: string | null;
  completedAt: number;
}

/** Flip to a terminal status. Idempotent at the row level — repeated calls
 *  with the same terminal status are no-ops. */
export function markAgentRunTerminal(input: MarkAgentRunTerminalInput): void {
  getDb()
    .update(agentRuns)
    .set({
      status: input.status,
      result: input.result,
      failureCause: input.failureCause,
      failureReason: input.failureReason,
      completedAt: input.completedAt,
      rev: REV_INC,
    })
    .where(eq(agentRuns.id, input.id))
    .run();
}

/** Workflow-engine redesign — stamp the delivery receipt when the worker
 *  submits its deliverable (`pc_submit_deliverable`). The positive done-signal:
 *  read back at terminal time to distinguish a real completion from a
 *  `no-deliverable` failure. Idempotent (first delivery wins); does NOT bump rev
 *  (delivery is not itself a status transition — completion follows it). */
export function markAgentRunDelivered(id: ULID, at: number): void {
  getDb()
    .update(agentRuns)
    .set({ deliveredAt: at })
    .where(and(eq(agentRuns.id, id), sql`${agentRuns.deliveredAt} IS NULL`))
    .run();
}

/** Point read by ULID. `pc_continue_agent` calls this to validate the
 *  parent exists + is in a continuable state. */
export function getAgentRunRow(id: ULID): AgentRunRow | null {
  const row = getDb().select().from(agentRuns).where(eq(agentRuns.id, id)).get();
  return row ?? null;
}

export interface ListAgentRunsForSessionOptions {
  podName?: string;
  status?: AgentRunStatus;
  /** 1-based cap on returned rows. */
  limit: number;
}

/** Hot path for `pc_list_my_runs`. Filter by (project, dispatcher session),
 *  optionally by pod name / status. Newest first. */
export function listAgentRunsForSession(
  projectId: ULID,
  dispatcherSessionId: string,
  opts: ListAgentRunsForSessionOptions,
): AgentRunRow[] {
  const filters = [
    eq(agentRuns.projectId, projectId),
    eq(agentRuns.dispatcherSessionId, dispatcherSessionId),
  ];
  if (opts.podName) filters.push(eq(agentRuns.podName, opts.podName));
  if (opts.status) filters.push(eq(agentRuns.status, opts.status));
  return getDb()
    .select()
    .from(agentRuns)
    .where(and(...filters))
    .orderBy(desc(agentRuns.queuedAt))
    .limit(opts.limit)
    .all();
}

/** Activity Panel feeder. Lists non-terminal rows for a project
 *  (queued | spawning | running | paused). Newest first. */
export function listActiveAgentRunsForProject(projectId: ULID): AgentRunRow[] {
  return getDb()
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.projectId, projectId),
        inArray(agentRuns.status, ['queued', 'spawning', 'running', 'paused']),
      ),
    )
    .orderBy(desc(agentRuns.queuedAt))
    .all();
}

/** Boot/reconcile feeder. Lists every non-terminal row across projects. */
export function listNonTerminalAgentRuns(): AgentRunRow[] {
  return getDb()
    .select()
    .from(agentRuns)
    .where(inArray(agentRuns.status, ['queued', 'spawning', 'running', 'paused']))
    .orderBy(desc(agentRuns.queuedAt))
    .all();
}

/** S3 envelope-replay feeder. Lists terminal rows that finalized at/after
 *  `since` across projects (bounds the replay scan to a recent window so it's
 *  not a full-table sweep). Newest first. */
export function listRecentTerminalAgentRuns(since: number): AgentRunRow[] {
  return getDb()
    .select()
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.status, ['completed', 'failed', 'cancelled']),
        gte(agentRuns.completedAt, since),
      ),
    )
    .orderBy(desc(agentRuns.completedAt))
    .all();
}

/** Concurrent-continuation guard. Returns a non-terminal continuation row
 *  if one exists for `priorRunId`. `pc_continue_agent` rejects with 409
 *  when this comes back non-null. */
export function findActiveContinuation(priorRunId: ULID): AgentRunRow | null {
  const row = getDb()
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.continues, priorRunId),
        inArray(agentRuns.status, ['queued', 'spawning', 'running', 'paused']),
      ),
    )
    .get();
  return row ?? null;
}

// Step 2 (2026-06-03) — the boot-time bulk-fail sweeps (`reconcileOrphanedRunningRuns`,
// `listAndReconcileOrphanedRuns`) are DELETED. They flipped rows terminal with a raw
// UPDATE — bypassing the one terminal authority — and killed `paused` rows (FD-14
// violation). The agent-run reconciler loop (apps/server agent-run-reconciler.ts)
// owns orphan detection now; every finalize routes through applyAgentRunTerminalEffects.

// ── Slice 013 — agent_runs.contract_id link (additive) ───────────────────────

/** Point an agent_run at the first-class contract it's producing. Does NOT
 *  bump rev — the contract link is dispatch bookkeeping, not a status
 *  transition the frontend versions. Idempotent. */
export function setAgentRunContractId(id: ULID, contractId: ULID | null): void {
  getDb().update(agentRuns).set({ contractId }).where(eq(agentRuns.id, id)).run();
}
