// Section 25 — agent_runs repo.
//
// Persists the FULL state machine (queued | spawning | running | paused |
// completed | failed | cancelled). Restart-time reconciliation is a SELECT *
// WHERE status IN ('queued','spawning','running','paused') — no in-memory
// state to lose.
//
// Continuation lineage via `continues` self-FK. `findActiveContinuation`
// guards `pc_continue_agent` against double-continuation of the same parent.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

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
    completedAt: null,
    rev: 0,
    contractId: input.contractId ?? null,
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

/** Boot-time reconciliation sweep. Any row stuck in a non-terminal status
 *  when the server starts means the prior process died mid-flight. Flip
 *  them to `failed / server-restart` so subsequent queries don't treat
 *  them as live. Returns the count of rows affected. */
export function reconcileOrphanedRunningRuns(now: number): number {
  const res = getDb()
    .update(agentRuns)
    .set({
      status: 'failed',
      failureReason: 'server restarted before this run completed',
      failureCause: 'server-restart',
      completedAt: now,
      rev: REV_INC,
    })
    .where(inArray(agentRuns.status, ['queued', 'spawning', 'running', 'paused']))
    .run();
  return res.changes;
}

/** Boot-time reconciliation sweep — announcing variant. Lists non-terminal
 *  rows first, bulk-updates to failed (with rev++), then reads them back so
 *  the caller can broadcast a `agent-run-changed` delta for each. Used by
 *  the boot reconcile path to make `reconcileOrphanedRunningRuns` visible
 *  in the right rail. */
export function listAndReconcileOrphanedRuns(now: number): AgentRunRow[] {
  const NON_TERMINAL: AgentRunStatus[] = ['queued', 'spawning', 'running', 'paused'];
  const rows = getDb()
    .select()
    .from(agentRuns)
    .where(inArray(agentRuns.status, NON_TERMINAL))
    .all() as AgentRunRow[];

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  getDb()
    .update(agentRuns)
    .set({
      status: 'failed',
      failureReason: 'server restarted before this run completed',
      failureCause: 'server-restart',
      completedAt: now,
      rev: REV_INC,
    })
    .where(inArray(agentRuns.id, ids))
    .run();

  // Read updated rows back so callers have the correct rev for announcement.
  return getDb()
    .select()
    .from(agentRuns)
    .where(inArray(agentRuns.id, ids))
    .all() as AgentRunRow[];
}

// ── Slice 013 — agent_runs.contract_id link (additive) ───────────────────────

/** Point an agent_run at the first-class contract it's producing. Does NOT
 *  bump rev — the contract link is dispatch bookkeeping, not a status
 *  transition the frontend versions. Idempotent. */
export function setAgentRunContractId(id: ULID, contractId: ULID | null): void {
  getDb().update(agentRuns).set({ contractId }).where(eq(agentRuns.id, id)).run();
}
