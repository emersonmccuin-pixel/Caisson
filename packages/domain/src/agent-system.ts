// Section 25 — agent system domain types (post-Phase-E bare names).
//
// Persisted shapes for the agent dispatch + pause + delivery layer. Mirrors
// the `agent_runs` / `pending_asks` / `agent_inbox` / `agent_delivery_audit`
// tables in `@pc/db`. Wire-level event kinds + payloads live in
// `agent-comms.ts` (`AgentChannelEventKind` etc.).

import type { ULID } from './ulid.ts';
import type { PendingAskOption } from './agent-comms.ts';

/** Full in-memory state machine, persisted 1:1. */
export type AgentRunStatus =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
  'queued',
  'spawning',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

/** Coarse failure taxonomy. The wrapper picks one at terminal-failed; the
 *  route layer never invents new ones (preserves the closed-world property). */
export type AgentRunFailureCause =
  | 'spawn-stuck'
  /** ☠ HISTORICAL ONLY (Step 8/FD-17): no live writer — idle-kill is deleted.
   *  Kept so pre-P9 terminal rows still type/display. */
  | 'idle-timeout'
  | 'wall-clock-timeout'
  | 'ready-timeout'
  | 'spawn-error'
  | 'send-failed'
  | 'unexpected-exit'
  | 'cancel-while-queued'
  | 'cancelled'
  | 'mcp-handshake-never'
  | 'kill-during-spawn'
  | 'server-restart'
  | 'host-unavailable'
  | 'host-lost'
  | 'host-crashed'
  | 'host-protocol-error'
  /** The host was reachable and ANSWERED, but rejected the command (e.g. a
   *  genuine run-id/cc-session collision). Distinct from 'host-unavailable'
   *  (no answer at all) — conflating the two produced the misleading
   *  "run already exists / host-unavailable" spawn error (2026-06-10). */
  | 'host-rejected'
  /** Workflow-engine redesign — the dispatched worker reached a terminal
   *  WITHOUT submitting a deliverable against its contract. Delivery is the
   *  sole done-signal; ending a turn / exiting with nothing delivered is a
   *  failure with a reason, not a silent "completed-but-empty". */
  | 'no-deliverable'
  /** Contract invariant: the dispatch was aborted because the contract could
   *  not be resolved or created. A run must ALWAYS have a contract before the
   *  agent spawns; if one can't be guaranteed the dispatch is refused. */
  | 'contract-required'
  /** Isolation invariant: the dispatch declared `isolation: "worktree"` but
   *  the worktree provisioning step failed. Never fall back to the main repo. */
  | 'worktree-provision-failed';

export const AGENT_RUN_FAILURE_CAUSES: readonly AgentRunFailureCause[] = [
  'spawn-stuck',
  'idle-timeout',
  'wall-clock-timeout',
  'ready-timeout',
  'spawn-error',
  'send-failed',
  'unexpected-exit',
  'cancel-while-queued',
  'cancelled',
  'mcp-handshake-never',
  'kill-during-spawn',
  'server-restart',
  'host-unavailable',
  'host-lost',
  'host-crashed',
  'host-protocol-error',
  'host-rejected',
  'no-deliverable',
  'contract-required',
  'worktree-provision-failed',
];

/** One persisted agent_runs row. Mirrors the in-memory AgentRunRecord plus
 *  drift-detection fields and explicit lifecycle timestamps. */
export interface AgentRunRow {
  id: ULID;
  projectId: ULID;
  /** PC session-id (ULID) of the orchestrator (or other AgentRun) that
   *  dispatched this run. */
  dispatcherSessionId: string;
  /** CC's provider session-id. UUID. Reused via `--resume` on continuation. */
  ccSessionId: string;
  podName: string;
  /** Updated-at hash (or revision string) of the pod row at dispatch time.
   *  Used by drift detection to flag continuations against an edited pod.
   *  NULL when the materialiser didn't supply a revision. */
  podRevisionAtDispatch: string | null;
  /** Updated-at hash of the pod row at resume time. Differs from
   *  `podRevisionAtDispatch` iff the pod was edited between dispatch and
   *  resume. NULL for non-resumed runs. */
  podRevisionAtResume: string | null;
  status: AgentRunStatus;
  /** Self-FK to parent run for continuations. */
  continues: ULID | null;
  parentInvokeDepth: number;
  parentWorkItemId: ULID | null;
  /** Slice 013 — FK to the first-class `agent_contracts` row this run produces.
   *  NULL for legacy/non-contract dispatches + un-backfilled rows. */
  contractId: ULID | null;
  /** Verbatim initial input. NULL on resumes that carry no new input. */
  input: string | null;
  /** Final assistant text. NULL until terminal-completed. */
  result: string | null;
  failureCause: AgentRunFailureCause | null;
  failureReason: string | null;
  queuedAt: number;
  spawnedAt: number | null;
  readyAt: number | null;
  /** OS pid of the spawned claude.exe (in-process path). Persisted at spawn so
   *  the liveness sweep can probe process existence and hard-kill can target the
   *  real process. NULL before spawn / host-mode runs. */
  pid: number | null;
  /** Epoch-ms of the last observed JSONL activity. Drives the stall ladder's
   *  idle computation (badge → verify-alive → notify — never a kill).
   *  NULL until the first event lands. */
  lastActivityAt: number | null;
  /** Workflow-engine redesign — epoch-ms when the worker submitted its
   *  deliverable (`pc_submit_deliverable`). The positive done-receipt: a run
   *  with a contract but no `deliveredAt` that reaches a terminal is a
   *  `no-deliverable` failure. NULL until/unless a deliverable is submitted. */
  deliveredAt: number | null;
  completedAt: number | null;
  /** Monotonic write counter. Incremented by every status transition so WS
   *  deltas can carry a version the frontend uses to discard stale delivery. */
  rev: number;
  /** Absolute path to the worktree directory the agent was spawned in. Used to
   *  compute the correct CC JSONL path (CC keys its projects/ dir off the spawn
   *  cwd). NULL for rows created before this column was added — callers fall back
   *  to `project.folderPath` when null. */
  worktreeDir: string | null;
}

/** Pending-ask kind. ☠ M7 (FD-6, 2026-06-04) — `'user'` deleted with
 *  `pc_ask_user`: ONE ask door, agents only ask the orchestrator. Historical
 *  rows with `kind='user'` may exist in old DBs; reads stay tolerant. */
export type PendingAskKind = 'orchestrator' | 'approval';

export const PENDING_ASK_KINDS: readonly PendingAskKind[] = [
  'orchestrator',
  'approval',
];

export type PendingAskStatus = 'open' | 'answered' | 'cancelled';

export const PENDING_ASK_STATUSES: readonly PendingAskStatus[] = [
  'open',
  'answered',
  'cancelled',
];

export interface PendingAskRow {
  id: ULID;
  agentRunId: ULID;
  /** Denormalised — survives agent_run row deletion / archival. */
  ccSessionId: string;
  projectId: ULID;
  parentWorkItemId: ULID | null;
  kind: PendingAskKind;
  promptBody: string;
  context: string | null;
  /** Multi-choice for `approval` (always populated) and optional for
   *  `orchestrator` asks. */
  options: PendingAskOption[] | null;
  status: PendingAskStatus;
  answerBody: string | null;
  answeredBy: 'orchestrator' | 'user' | null;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
}

/** Inbox event-kind set. Superset of the wire `AgentChannelEventKind` —
 *  adds `agent-run-changed` + `agent-jsonl-event` for Activity Panel
 *  consumers. ☠ M7 (FD-6) — `agent-asks-user` deleted with `pc_ask_user`. */
export type AgentInboxEventKind =
  | 'agent-asks-orchestrator'
  | 'agent-approval-request'
  | 'agent-completed'
  | 'agent-failed'
  | 'agent-queued-started'
  | 'agent-run-changed'
  | 'agent-jsonl-event';

export const AGENT_INBOX_EVENT_KINDS: readonly AgentInboxEventKind[] = [
  'agent-asks-orchestrator',
  'agent-approval-request',
  'agent-completed',
  'agent-failed',
  'agent-queued-started',
  'agent-run-changed',
  'agent-jsonl-event',
];

// ☠ M4a (2026-06-04) — AgentInboxStatus/Driver/Row + AgentDeliveryAuditRow
// deleted with the `agent_inbox` tables (migration 0041 archive). The
// AgentInboxEventKind union above SURVIVES — it names the envelope kinds the
// mailbox delivery path still routes (deliverAgentEnvelope).
