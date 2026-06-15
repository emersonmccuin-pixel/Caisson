// Section 19.3/19.4 — v2 workflow run sidecar + event-log repo. Coexists with
// the legacy workflow-runs.ts repo until 19.13 cutover. Re-exported from the
// barrel under the `workflowRunsV2Repo` namespace (avoids createRun/getRun
// name collisions with the legacy repo).
//
// Records use epoch-ms numbers (the WorkflowV2 domain convention) — no ISO
// conversion. Node OUTPUTS live on child work items, not here; this repo only
// persists DAG bookkeeping (dag_state) + the append-only event log.

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ULID, WorkflowV2 } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { workflowRunEvents, workflowRunsV2 } from '../schema.ts';

export interface WorkflowRunV2Record {
  id: ULID;
  workflowId: string;
  workflowName: string;
  projectId: ULID;
  workItemId: ULID | null;
  status: WorkflowV2.WorkflowRunStatus;
  workflowYamlSnapshot: string;
  worktreePath: string | null;
  worktreeBaseBranch: string | null;
  worktreeBaseSha: string | null;
  dagState: WorkflowV2.WorkflowDagState;
  metadata: Record<string, unknown>;
  lastReason: string | null;
  /** Monotonic write counter. Incremented inside every mutating write. */
  rev: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
}

export interface CreateRunInput {
  workflowId: string;
  workflowName: string;
  projectId: ULID;
  workflowYamlSnapshot: string;
  status?: WorkflowV2.WorkflowRunStatus;
  workItemId?: ULID | null;
  worktreePath?: string | null;
  worktreeBaseBranch?: string | null;
  worktreeBaseSha?: string | null;
  dagState?: WorkflowV2.WorkflowDagState;
  metadata?: Record<string, unknown>;
}

const TERMINAL: ReadonlySet<WorkflowV2.WorkflowRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export function createRun(input: CreateRunInput): WorkflowRunV2Record {
  const now = Date.now();
  const row: WorkflowRunV2Record = {
    id: newId(),
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    projectId: input.projectId,
    workItemId: input.workItemId ?? null,
    status: input.status ?? 'pending',
    workflowYamlSnapshot: input.workflowYamlSnapshot,
    worktreePath: input.worktreePath ?? null,
    worktreeBaseBranch: input.worktreeBaseBranch ?? null,
    worktreeBaseSha: input.worktreeBaseSha ?? null,
    dagState: input.dagState ?? { nodes: {} },
    metadata: input.metadata ?? {},
    lastReason: null,
    rev: 0,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    lastActivityAt: now,
  };
  getDb().insert(workflowRunsV2).values(row).run();
  return row;
}

export function getRun(id: ULID): WorkflowRunV2Record | null {
  const row = getDb()
    .select()
    .from(workflowRunsV2)
    .where(eq(workflowRunsV2.id, id))
    .get() as WorkflowRunV2Record | undefined;
  return row ?? null;
}

/** Read one run by id, scoped to a project (404s on mismatch — no info leak). */
export function getRunForProject(id: ULID, projectId: ULID): WorkflowRunV2Record | null {
  const row = getDb()
    .select()
    .from(workflowRunsV2)
    .where(and(eq(workflowRunsV2.id, id), eq(workflowRunsV2.projectId, projectId)))
    .get() as WorkflowRunV2Record | undefined;
  return row ?? null;
}

export function listRunsByProject(projectId: ULID): WorkflowRunV2Record[] {
  return getDb()
    .select()
    .from(workflowRunsV2)
    .where(eq(workflowRunsV2.projectId, projectId))
    .orderBy(asc(workflowRunsV2.createdAt))
    .all() as WorkflowRunV2Record[];
}

/** Slice 004 — additive read for boot reconciliation. Returns all runs whose
 *  status is in the given set, ordered oldest-first, across every project. */
export function listRunsByStatus(
  statuses: readonly WorkflowV2.WorkflowRunStatus[],
): WorkflowRunV2Record[] {
  if (statuses.length === 0) return [];
  return getDb()
    .select()
    .from(workflowRunsV2)
    .where(inArray(workflowRunsV2.status, statuses as WorkflowV2.WorkflowRunStatus[]))
    .orderBy(asc(workflowRunsV2.createdAt))
    .all() as WorkflowRunV2Record[];
}

export function getRunByWorkItem(workItemId: ULID): WorkflowRunV2Record | null {
  const row = getDb()
    .select()
    .from(workflowRunsV2)
    .where(eq(workflowRunsV2.workItemId, workItemId))
    .get() as WorkflowRunV2Record | undefined;
  return row ?? null;
}

const REV_INC = sql`rev + 1` as unknown as number;

/** Replace the DAG state blob (per-node records + reject-iteration counts). */
export function setDagState(id: ULID, dagState: WorkflowV2.WorkflowDagState): void {
  getDb()
    .update(workflowRunsV2)
    .set({ dagState, lastActivityAt: Date.now(), rev: REV_INC })
    .where(eq(workflowRunsV2.id, id))
    .run();
}

export function markStarted(id: ULID): void {
  const now = Date.now();
  getDb()
    .update(workflowRunsV2)
    .set({ status: 'running', startedAt: now, lastActivityAt: now, rev: REV_INC })
    .where(eq(workflowRunsV2.id, id))
    .run();
}

/** M6 slice C (FD-11 restart-at-step) — re-freeze the run's definition
 *  snapshot on an explicit resume-from-failed (the ONE door through which an
 *  edited definition reaches an existing run). Called only inside the resume
 *  gateway txn. */
export function setWorkflowYamlSnapshot(id: ULID, workflowYamlSnapshot: string): void {
  getDb()
    .update(workflowRunsV2)
    .set({ workflowYamlSnapshot, lastActivityAt: Date.now(), rev: REV_INC })
    .where(eq(workflowRunsV2.id, id))
    .run();
}

/** Transition status. Sets `endedAt` on terminal transitions; clears it on a
 *  non-terminal transition (a resumed run is no longer "ended" — M6 slice C). */
export function setStatus(
  id: ULID,
  status: WorkflowV2.WorkflowRunStatus,
  opts: { lastReason?: string | null } = {}
): void {
  const now = Date.now();
  const patch: Partial<WorkflowRunV2Record> = { status, lastActivityAt: now, rev: REV_INC };
  if (opts.lastReason !== undefined) patch.lastReason = opts.lastReason;
  patch.endedAt = TERMINAL.has(status) ? now : null;
  getDb().update(workflowRunsV2).set(patch).where(eq(workflowRunsV2.id, id)).run();
}

// --- event log: THE RUN DIARY (M3a/FD-11/FD-13) ---------------------------
// `appendEvent` may be called ONLY through WorkflowRunMutationGateway.
// appendRunEvent (event row + workflow.run.event outbox fact, one txn) —
// a direct call is an FD-12 bypass; the diary gate test enforces it.

export interface AppendEventInput {
  runId: ULID;
  type: WorkflowV2.WorkflowEventType;
  nodeId?: string | null;
  data?: Record<string, unknown>;
}

export interface WorkflowRunEventRecord {
  id: ULID;
  runId: ULID;
  type: WorkflowV2.WorkflowEventType;
  nodeId: string | null;
  data: Record<string, unknown> | null;
  at: number;
}

export function appendEvent(input: AppendEventInput): WorkflowRunEventRecord {
  const row: WorkflowRunEventRecord = {
    id: newId(),
    runId: input.runId,
    type: input.type,
    nodeId: input.nodeId ?? null,
    data: input.data ?? null,
    at: Date.now(),
  };
  getDb().insert(workflowRunEvents).values(row).run();
  return row;
}

export function listEvents(runId: ULID): WorkflowRunEventRecord[] {
  return getDb()
    .select()
    .from(workflowRunEvents)
    .where(eq(workflowRunEvents.runId, runId))
    .orderBy(asc(workflowRunEvents.at))
    .all() as WorkflowRunEventRecord[];
}
