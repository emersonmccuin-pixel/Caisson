// WorkItem domain type. The unit of work that flows between project stages.
// Persisted as a row in the sqlite `work_items` table.

import type { ULID } from './ulid.ts';

export type WorkItemStatus =
  | 'pending'
  | 'in-progress'
  | 'awaiting-verification'
  | 'blocked'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'archived';

/** Built-in, fixed-set work-item types. Extendable later — not per-project
 *  configurable today (rationale in the work-item type contract). */
export const WORK_ITEM_TYPES = ['task', 'bug', 'feature', 'spike'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export function isWorkItemType(value: unknown): value is WorkItemType {
  return typeof value === 'string' && (WORK_ITEM_TYPES as readonly string[]).includes(value);
}

export interface WorkItem {
  id: ULID;
  projectId: ULID;
  parentId: ULID | null;
  /** Sort key within (parentId, stageId). Stable across moves. */
  position: number;
  title: string;
  body: string;
  stageId: string;
  status: WorkItemStatus;
  /** Reason for the current status when not `pending` — surfaced in the UI. */
  statusReason: string | null;
  /** Built-in type. Default `task` for legacy rows. Bug is the type filed by `pc_log_bug`. */
  type: WorkItemType;
  fields: Record<string, unknown>;
  /** Optimistic-concurrency counter. Bumped on every mutation; client must echo it on PATCH. */
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Soft-delete timestamp. status='archived' is the user-facing concept. */
  deletedAt: number | null;
  /** Append-only event log. `move` + `update` written by the repo; agent-comms
   *  rows written by the agent-comms HTTP routes (Section 16b.7). Rendered in
   *  the work-item detail modal's Activity tab. */
  history: WorkItemHistoryEntry[];
  /** Section 19 — true when this row is a v2 workflow run's root. Each
   *  workflow node spawns a child WI under it; DAG state lives in
   *  `workflow_runs_v2` keyed by this id. Optional: pre-Section-19 rows + most
   *  WorkItem constructors omit it (treated as false). */
  isWorkflowRoot?: boolean;
  /** Section 35 — display-alias short code (e.g. `pc-2`, `pc-2.1`). ULID
   *  stays canonical. Write-once: stable across re-parenting. */
  callsign: string | null;
  /** Slice 010 — Area bucket FK, or null for Uncaptured. */
  areaId: ULID | null;
}

/** Append-only event log written by mutation paths in the repo + by the
 *  agent-comms HTTP routes (Section 16b.7). Surfaced on the public WorkItem
 *  shape; consumed by the work-item detail modal's Activity tab. Older
 *  rows (`move` / `update`) carry the original optional shape; `agent-*`
 *  rows carry the agent-context fields. */
export interface WorkItemHistoryEntry {
  ts: string;
  kind:
    | 'move'
    | 'update'
    | 'agent-invoke'
    | 'agent-ask-orchestrator'
    | 'agent-ask-user'
    | 'agent-approval-request'
    | 'agent-answer'
    | 'agent-completed'
    | 'agent-failed';
  /** `move` from-stage. */
  from?: string;
  /** `move` to-stage. */
  to?: string;
  /** `update` field-merge payload. */
  fields?: Record<string, unknown>;
  /** Free-form display note. `applyRunOutcome` + agent-comms summaries use
   *  this for the human-readable line in the Activity tab. */
  note?: string;
  // ── agent-* context ──
  /** Agent name for any `agent-*` entry. */
  agentName?: string;
  /** CC session-id for any `agent-*` entry. Same across pause/resume of one run. */
  sessionId?: string;
  /** PC-minted run-id (only present for entries that originate from
   *  `pc_invoke_agent`-tracked runs). */
  runId?: string;
  /** PC-minted pending-ask id (present on `agent-ask-*` /
   *  `agent-approval-request` and the matching `agent-answer`). */
  pendingAskId?: string;
  /** For `agent-invoke` entries: whether the caller blocked on the result. */
  invokeMode?: 'sync' | 'async';
  /** For `agent-answer` entries: who supplied the answer (orchestrator vs user). */
  answeredBy?: 'orchestrator' | 'user';
  /** For `agent-failed` entries: narrow cause for the orchestrator handler protocol. */
  cause?: string;
}
