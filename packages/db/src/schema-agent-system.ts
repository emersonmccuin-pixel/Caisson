// Section 25 — agent system tables (post-Phase-E bare names).
//
// Kept in a separate file from `schema.ts` so the agent-system concern stays
// grep-able. Tables are bare-named — the legacy v1 set was renamed to
// `*_v1_archive` by migration 0015 (Phase D, Session 11).
//
// Conventions match schema.ts: ULID PKs as `text`, timestamps as `integer`
// epoch ms, JSON blobs via `text({ mode: 'json' })`, foreign keys declared via
// `.references(...)`.

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  AcceptanceCriteria,
  AgentRunFailureCause,
  AgentRunStatus,
  ContractStatus,
  ContractV2,
  Deliverable,
  PendingAskKind,
  PendingAskOption,
  PendingAskStatus,
  ULID,
  VerificationStatus,
  VerificationTier,
} from '@pc/domain';

import { projects } from './schema.ts';

/**
 * Persisted dispatch record. Mirrors the in-memory AgentRunRecord 1:1 —
 * intermediate states (`queued | spawning | running | paused`) are persisted
 * alongside the terminal states (`completed | failed | cancelled`).
 *
 * Continuation lineage via `continues` (self-FK). Each `pc_continue_agent`
 * dispatch creates a new row whose `cc_session_id` matches the parent's.
 * Walking `continues` backwards reconstructs the chain.
 *
 * `pod_revision_at_dispatch` + `pod_revision_at_resume` enable drift
 * detection. If they differ, the orchestrator can surface "the pod changed
 * between dispatch and resume" to the user.
 */
export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    /** PC session-id of the dispatcher (orchestrator or parent agent). */
    dispatcherSessionId: text('dispatcher_session_id').notNull(),
    /** CC's provider session-id (UUID). Continuations share this with parent. */
    ccSessionId: text('cc_session_id').notNull(),
    podName: text('pod_name').notNull(),
    /** Updated-at hash of the pod row at dispatch time. Drift-detection input. */
    podRevisionAtDispatch: text('pod_revision_at_dispatch'),
    /** Updated-at hash at resume time. NULL until resumed. */
    podRevisionAtResume: text('pod_revision_at_resume'),
    status: text('status').notNull().$type<AgentRunStatus>(),
    /** Self-FK to parent run id for continuations. NULL for original
     *  dispatches. */
    continues: text('continues').$type<ULID | null>(),
    parentInvokeDepth: integer('parent_invoke_depth').notNull().default(0),
    parentWorkItemId: text('parent_work_item_id').$type<ULID | null>(),
    /** Slice 013 — FK to the first-class `agent_contracts` row this run is
     *  producing. Nullable: legacy/un-backfilled runs + non-contract dispatches
     *  stay NULL (the read-through shim falls back to the work-item contract
     *  columns). No DB FK declared (app-enforced, mirrors `areaId`). */
    contractId: text('contract_id').$type<ULID | null>(),
    /** Verbatim initial input. NULL on resumes carrying no new input. */
    input: text('input'),
    /** Final assistant text. NULL until terminal-completed. */
    result: text('result'),
    failureCause: text('failure_cause').$type<AgentRunFailureCause | null>(),
    failureReason: text('failure_reason'),
    queuedAt: integer('queued_at').notNull(),
    spawnedAt: integer('spawned_at'),
    readyAt: integer('ready_at'),
    /** OS process id of the spawned claude.exe (in-process path). Persisted at
     *  spawn so the liveness sweep can probe `process.kill(pid, 0)` and hard-kill
     *  can target the real process even after the in-memory handle is lost.
     *  NULL before spawn / for host-mode runs. */
    pid: integer('pid'),
    /** Epoch-ms of the last observed JSONL activity for this run. Updated by the
     *  tailer; the liveness sweep flags an alive-but-idle run as wedged. */
    lastActivityAt: integer('last_activity_at'),
    /** Workflow-engine redesign — epoch-ms the worker submitted its deliverable
     *  (`pc_submit_deliverable`). The positive done-receipt: a contract-first run
     *  that reaches terminal without this set is a `no-deliverable` failure. */
    deliveredAt: integer('delivered_at'),
    completedAt: integer('completed_at'),
    /** Monotonic write counter — incremented on every status transition.
     *  WS deltas carry this so the frontend can discard stale deliveries. */
    rev: integer('rev').notNull().default(0),
  },
  (t) => [
    index('agent_runs_session_queued_idx').on(t.dispatcherSessionId, t.queuedAt),
    index('agent_runs_continues_idx').on(t.continues),
    index('agent_runs_project_status_idx').on(t.projectId, t.status),
    index('agent_runs_cc_session_idx').on(t.ccSessionId),
    index('agent_runs_contract_idx').on(t.contractId),
  ],
);

/**
 * Slice 013 — first-class agent contract. A machine assignment with a typed,
 * verified output — NOT a work item. Extracts the contract off `work_items`
 * (Section 26 bolted it on); the legacy work_items contract columns are KEPT
 * this slice as a read-through shim, removed in 014/cleanup.
 *
 * - `workItemId` — OPTIONAL FK; many contracts : one work item (powers the
 *   work-log). Null = a contract with no human work item. No DB FK declared
 *   (app-enforced, mirrors `work_items.area_id`).
 * - `deliverable` lives HERE (typed v2 union), not borrowed from `wi.body`.
 * - `report` is the free-text envelope to the orchestrator.
 * - ☠ M6 slice D: `attempt` + `issued_by` dropped (migration 0044) — written
 *   as 0/NULL by every caller since the table was born; retries are the
 *   workflow LOOP's business, provenance is the diary's.
 *
 * Verification behavior is unchanged this slice — predicates/tiers move as-is.
 */
export const agentContracts = sqliteTable(
  'agent_contracts',
  {
    id: text('id').primaryKey().$type<ULID>(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    /** Optional, one-to-many rollup to a human work item. */
    workItemId: text('work_item_id').$type<ULID | null>(),
    /** The producing run. NULL until dispatched. */
    agentRunId: text('agent_run_id').$type<ULID | null>(),
    podName: text('pod_name'),
    /** Orchestrator's typed spec (v2 union). */
    expectedOutput: text('expected_output', { mode: 'json' }).$type<ContractV2.ExpectedOutput>(),
    /** Derived predicate set. */
    acceptanceCriteria: text('acceptance_criteria', { mode: 'json' }).$type<AcceptanceCriteria>(),
    verificationTier: text('verification_tier').$type<VerificationTier>(),
    verificationStatus: text('verification_status').$type<VerificationStatus>(),
    verificationNotes: text('verification_notes'),
    /** Free text to the orchestrator. */
    report: text('report'),
    /** The captured typed artifact — owned here (v2 Deliverable union). */
    deliverable: text('deliverable', { mode: 'json' }).$type<Deliverable>(),
    /** Isolation axis for repo/file producers. */
    worktreePath: text('worktree_path'),
    status: text('status').notNull().default('issued').$type<ContractStatus>(),
    /** Optimistic-concurrency counter. */
    version: integer('version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('agent_contracts_project_idx').on(t.projectId),
    index('agent_contracts_work_item_idx').on(t.workItemId),
    index('agent_contracts_run_idx').on(t.agentRunId),
  ],
);

/**
 * One row per pause event. Survives the CC child process exiting (CC exits
 * cleanly on pause — JSONL state is preserved on disk; PC's `agent_runs`
 * status flips to `'paused'`).
 *
 * Status enforces "answer-once": the route layer transitions `open → answered`
 * (or `open → cancelled`) atomically via UPDATE WHERE status='open'.
 */
export const pendingAsks = sqliteTable(
  'pending_asks',
  {
    id: text('id').primaryKey().$type<ULID>(),
    agentRunId: text('agent_run_id')
      .notNull()
      .$type<ULID>()
      .references(() => agentRuns.id),
    /** Denormalised CC provider session-id; survives the agent_run row being
     *  archived. */
    ccSessionId: text('cc_session_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .$type<ULID>()
      .references(() => projects.id),
    parentWorkItemId: text('parent_work_item_id').$type<ULID | null>(),
    kind: text('kind').notNull().$type<PendingAskKind>(),
    promptBody: text('prompt_body').notNull(),
    context: text('context'),
    options: text('options', { mode: 'json' }).$type<PendingAskOption[] | null>(),
    status: text('status').notNull().default('open').$type<PendingAskStatus>(),
    answerBody: text('answer_body'),
    answeredBy: text('answered_by').$type<'orchestrator' | 'user' | null>(),
    createdAt: integer('created_at').notNull(),
    answeredAt: integer('answered_at'),
    cancelledAt: integer('cancelled_at'),
  },
  (t) => [
    index('pending_asks_project_status_idx').on(t.projectId, t.status),
    index('pending_asks_agent_run_idx').on(t.agentRunId),
    index('pending_asks_cc_session_idx').on(t.ccSessionId),
  ],
);

// ☠ M4a (2026-06-04, FD-12 bypass #3 EXECUTED): `agent_inbox` +
// `agent_delivery_audit` are GONE (migration 0041 archive-renames them to
// *_v2_archive). They were the pre-mailbox delivery durability layer; the
// last writer (`enqueueInboxRow` via the old enqueueAndPush) died in slice
// 017 Phase C, and the `inbox-drain.cjs` hook then drained an eternally-empty
// table on every prompt for weeks. The mailbox (mailbox_messages/recipients/
// deliveries + the worker) is the ONE delivery system.
