// Workflow run mutation gateway (slice 004) — the single durable write door for
// workflow_runs_v2 row mutations. Mirrors the slice-003 WorkItemMutationGateway.
//
// Every durable run transition (fire / advance / review-pending / review-resolve
// / cancel / reconcile) flows through here so each has ONE durable fact point.
// Pattern (slice 002/003):
//   run a caller-supplied product mutation -> insert a live_outbox row in the
//   SAME getDb().transaction -> return a publication the server composition
//   layer fans out (canonical {type:'live-event',event} + legacy WS name) AFTER
//   commit. A rollback emits nothing.
//
// Boundary purity: imports only @pc/contracts, @pc/db, @pc/domain (+ the local
// adapters). No Hono, React, websocket hub, Channel, MCP SDK, or runtime
// process classes. Fanout (broadcast) is wired at the server composition layer.

import type {
  WorkflowReviewChangedLivePayload,
  WorkflowReviewFlavor,
  WorkflowReviewState,
  WorkflowRunChangedLivePayload,
  WorkflowRunChangedReason,
  WorkflowRunDto,
  WorkflowRunEventLivePayload,
} from '@pc/contracts';
import {
  getDb,
  insertLiveEvent,
  workflowRunsV2Repo,
  type DbExecutor,
  type InsertLiveEventDraft,
  type LiveOutboxEvent,
  type WorkflowRunV2Record,
} from '@pc/db';

/** The repo is namespace-exported; alias its event-record type locally. */
type WorkflowRunEventRecord = workflowRunsV2Repo.WorkflowRunEventRecord;
import type { ULID, WorkflowV2 } from '@pc/domain';
import { toWorkflowRunDto } from './adapters.ts';

export interface WorkflowRunChangedPublication {
  liveEvent: LiveOutboxEvent<WorkflowRunChangedLivePayload>;
  run: WorkflowRunDto;
}

export interface WorkflowReviewChangedPublication {
  liveEvent: LiveOutboxEvent<WorkflowReviewChangedLivePayload>;
}

export interface WorkflowRunEventPublication {
  liveEvent: LiveOutboxEvent<WorkflowRunEventLivePayload>;
  event: WorkflowRunEventRecord;
}

const TERMINAL: ReadonlySet<WorkflowV2.WorkflowRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export function buildWorkflowRunChangedDraft(input: {
  projectId: ULID;
  reason: WorkflowRunChangedReason;
  run: WorkflowRunDto;
}): InsertLiveEventDraft<WorkflowRunChangedLivePayload> {
  return {
    scope: 'project',
    projectId: input.projectId,
    type: 'workflow.run.changed',
    entity: 'workflow-run',
    entityId: input.run.id as ULID,
    version: input.run.rev,
    payload: { reason: input.reason, run: input.run },
  };
}

/** M3a — one diary line as a first-class live fact. `version` is null: diary
 *  lines are append-only (no rev to guard); clients key dedup off the event id. */
export function buildWorkflowRunEventDraft(input: {
  projectId: ULID;
  event: WorkflowRunEventRecord;
}): InsertLiveEventDraft<WorkflowRunEventLivePayload> {
  return {
    scope: 'project',
    projectId: input.projectId,
    type: 'workflow.run.event',
    entity: 'workflow-run-event',
    entityId: input.event.runId,
    version: null,
    payload: { event: input.event },
  };
}

export function buildWorkflowReviewChangedDraft(input: {
  projectId: ULID;
  runId: ULID;
  nodeId: string;
  flavor: WorkflowReviewFlavor;
  state: WorkflowReviewState;
  rev: number;
  prompt?: string | null;
  notes?: string;
}): InsertLiveEventDraft<WorkflowReviewChangedLivePayload> {
  const payload: WorkflowReviewChangedLivePayload = {
    runId: input.runId,
    nodeId: input.nodeId,
    flavor: input.flavor,
    state: input.state,
  };
  if (input.prompt !== undefined) payload.prompt = input.prompt;
  if (input.notes !== undefined) payload.notes = input.notes;
  return {
    scope: 'project',
    projectId: input.projectId,
    type: 'workflow.review.changed',
    entity: 'workflow-review',
    entityId: input.runId,
    version: input.rev,
    payload,
  };
}

export interface WorkflowRunGatewayDeps {
  /** Single transaction door. Defaults to the live DB; tests inject a fake. */
  transaction?: <T>(fn: (tx: DbExecutor) => T) => T;
  /** Insert a live-outbox row inside the transaction. Defaults to @pc/db. */
  insertLiveEvent?: typeof insertLiveEvent;
  /** Read a run by id (defaults to the v2 repo). Overridable for tests. */
  getRun?: (id: ULID) => WorkflowRunV2Record | null;
  /** M3a — diary event-row insert (defaults to the v2 repo). Test seam. */
  appendEvent?: typeof workflowRunsV2Repo.appendEvent;
  /** Status write used by cancelRun (defaults to the v2 repo). Test seam. */
  setStatus?: typeof workflowRunsV2Repo.setStatus;
}

export class WorkflowRunMutationGateway {
  private readonly tx: <T>(fn: (tx: DbExecutor) => T) => T;
  private readonly insert: typeof insertLiveEvent;
  private readonly getRun: (id: ULID) => WorkflowRunV2Record | null;
  private readonly appendEvent: typeof workflowRunsV2Repo.appendEvent;
  private readonly setStatus: typeof workflowRunsV2Repo.setStatus;

  constructor(deps: WorkflowRunGatewayDeps = {}) {
    this.tx = deps.transaction ?? ((fn) => getDb().transaction(fn));
    this.insert = deps.insertLiveEvent ?? insertLiveEvent;
    this.getRun = deps.getRun ?? ((id) => workflowRunsV2Repo.getRun(id));
    this.appendEvent = deps.appendEvent ?? workflowRunsV2Repo.appendEvent;
    this.setStatus = deps.setStatus ?? workflowRunsV2Repo.setStatus;
  }

  /** Run a product mutation that returns the changed run row + record the
   *  matching canonical workflow.run.changed fact atomically. */
  commitRunChange(input: {
    projectId: ULID;
    reason: WorkflowRunChangedReason;
    mutate: (tx: DbExecutor) => WorkflowRunV2Record | null;
  }): WorkflowRunChangedPublication {
    return this.tx((tx) => {
      const row = input.mutate(tx);
      if (!row) throw new Error('workflow run mutation produced no row');
      const run = toWorkflowRunDto(row);
      const liveEvent = this.insert(
        tx,
        buildWorkflowRunChangedDraft({ projectId: input.projectId, reason: input.reason, run }),
      );
      return { liveEvent, run };
    });
  }

  /** Record a run fact when the product mutation already happened (used by the
   *  workflow-run-writer delegators after a repo write). Re-reads the row. */
  announceRunChange(input: {
    projectId: ULID;
    reason: WorkflowRunChangedReason;
    runId: ULID;
  }): WorkflowRunChangedPublication | null {
    const row = this.getRun(input.runId);
    if (!row) return null;
    return this.commitRunChange({
      projectId: input.projectId,
      reason: input.reason,
      mutate: () => row,
    });
  }

  /** M3a — THE diary door (FD-11/FD-13): append one `workflow_run_events` row
   *  + its `workflow.run.event` outbox fact in ONE transaction. Every diary
   *  line in the codebase flows through here; a direct repo `appendEvent` is
   *  an FD-12 bypass (gate-tested). The repo write joins the surrounding
   *  drizzle txn (same connection — the getRunInTx pattern). */
  appendRunEvent(input: {
    projectId: ULID;
    runId: ULID;
    type: WorkflowV2.WorkflowEventType;
    nodeId?: string | null;
    data?: Record<string, unknown>;
  }): WorkflowRunEventPublication {
    return this.tx((tx) => {
      const event = this.appendEvent({
        runId: input.runId,
        type: input.type,
        ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
      });
      const liveEvent = this.insert(
        tx,
        buildWorkflowRunEventDraft({ projectId: input.projectId, event }),
      );
      return { liveEvent, event };
    });
  }

  /** Record a durable review fact (pending / approved / rejected). */
  commitReviewChange(input: {
    projectId: ULID;
    runId: ULID;
    nodeId: string;
    flavor: WorkflowReviewFlavor;
    state: WorkflowReviewState;
    prompt?: string | null;
    notes?: string;
  }): WorkflowReviewChangedPublication {
    return this.tx((tx) => {
      const row = this.getRun(input.runId);
      const rev = row?.rev ?? 0;
      const liveEvent = this.insert(
        tx,
        buildWorkflowReviewChangedDraft({
          projectId: input.projectId,
          runId: input.runId,
          nodeId: input.nodeId,
          flavor: input.flavor,
          state: input.state,
          rev,
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        }),
      );
      return { liveEvent };
    });
  }

  /** Cancel a run through the gateway. Terminal runs are a no-op (returns null,
   *  emits nothing). Sets `cancelled` + the run fact + the `workflow_cancelled`
   *  diary line (M3a — the lifecycle bookend that was never written) in one tx. */
  cancelRun(input: { projectId: ULID; runId: ULID }): WorkflowRunChangedPublication | null {
    const existing = this.getRun(input.runId);
    if (!existing) return null;
    if (TERMINAL.has(existing.status)) return null;
    return this.tx((tx) => {
      this.setStatus(input.runId, 'cancelled', { lastReason: 'cancelled' });
      const row = this.getRunInTx(tx, input.runId);
      if (!row) throw new Error('workflow run mutation produced no row');
      const run = toWorkflowRunDto(row);
      const liveEvent = this.insert(
        tx,
        buildWorkflowRunChangedDraft({ projectId: input.projectId, reason: 'cancelled', run }),
      );
      const event = this.appendEvent({ runId: input.runId, type: 'workflow_cancelled' });
      this.insert(tx, buildWorkflowRunEventDraft({ projectId: input.projectId, event }));
      return { liveEvent, run };
    });
  }

  private getRunInTx(_tx: DbExecutor, runId: ULID): WorkflowRunV2Record | null {
    // The repo reads via getDb(); inside a getDb().transaction callback it
    // observes the just-written row on the same connection.
    return this.getRun(runId);
  }
}

export { TERMINAL as WORKFLOW_TERMINAL_STATUSES };
