// Section 16b — Agent comms primitives (contract layer).
//
// Four MCP tools (`pc_invoke_agent`, `pc_ask_orchestrator`,
// `pc_request_approval`, `pc_answer_pending`) + five channel-event kinds
// (`agent-asks-orchestrator`, `agent-approval-request`, `agent-completed`,
// `agent-failed`, `agent-queued-started`). Persisted pause-state shapes live
// in `agent-system.ts` (the `agent_runs` / `pending_asks` rows).
//
// ☠ M7 (FD-6, 2026-06-04) — `pc_ask_user` + `agent-asks-user` deleted: ONE ask
// door. Agents ask the orchestrator; it answers from project context or takes
// the question to the human in chat and relays (`answeredBy: 'user'`).
//
// Pause semantics (locked in Planning 2026-05-20; M5 sync-invoke DELETE):
// - `pc_invoke_agent` is NOT a pause kind. The call returns immediately and an
//   `agent-completed` / `agent-failed` event lands on the caller's stream when
//   the child finishes. (☠ the never-wired `wait: true` blocking mode.)
// - `pc_ask_orchestrator` / `pc_request_approval` ARE pause kinds. Tool
//   returns a pending-ask handle; the agent's process exits cleanly at turn
//   end; runtime re-spawns with `--resume <sessionId>` once the answer lands
//   and writes the answer as the next user message.
// - `pc_answer_pending` is the orchestrator's tool to resume a paused agent.

import type { ULID } from './ulid.ts';

/** One choice in an `options` list. `value` is what `pc_answer_pending`
 *  passes back as the answer; `label` is the user-facing string. */
export interface PendingAskOption {
  value: string;
  label: string;
}

// ─── Channel-event kinds (`agent-*` envelope on `<channel ...>` blocks) ───

/** Event kinds the orchestrator parses out of `<channel ...>` blocks. Four
 *  originate from a child agent (ask / approval + the two terminal events);
 *  `agent-queued-started` originates from PC itself (Section 18.7) when a
 *  previously-queued dispatch finally fires. */
export type AgentChannelEventKind =
  | 'agent-asks-orchestrator'
  | 'agent-approval-request'
  | 'agent-completed'
  | 'agent-failed'
  | 'agent-queued-started';

export const AGENT_CHANNEL_EVENT_KINDS: readonly AgentChannelEventKind[] = [
  'agent-asks-orchestrator',
  'agent-approval-request',
  'agent-completed',
  'agent-failed',
  'agent-queued-started',
];

/** Common fields every `agent-*` event carries. Concrete payloads extend
 *  this. `at` is epoch-ms of the event's emission. */
interface AgentEventCommon {
  pendingAskId: ULID | null;
  sessionId: string;
  agentName: string;
  runId: ULID | null;
  parentWorkItemId: ULID | null;
  at: number;
}

/** A paused agent asking the orchestrator — THE ask door (FD-6).
 *  Orchestrator's handler protocol: read question + context, answer via
 *  `pc_answer_pending` if context-known; if only the human can decide, ask
 *  the human in chat and relay (`answeredBy: 'user'`). */
export interface AgentAsksOrchestratorPayload extends AgentEventCommon {
  kind: 'agent-asks-orchestrator';
  pendingAskId: ULID;
  question: string;
  context: string | null;
  options: PendingAskOption[] | null;
}

/** A paused agent requesting human approval. Orchestrator's handler
 *  protocol entry #3: render the approval gate; forward decision via
 *  `pc_answer_pending`. Reuses the existing approval-bubble surface. */
export interface AgentApprovalRequestPayload extends AgentEventCommon {
  kind: 'agent-approval-request';
  pendingAskId: ULID;
  decision: string;
  options: PendingAskOption[];
  context: string | null;
}

/** A background-dispatched agent finished successfully. Orchestrator's
 *  handler protocol entry #4: start a new turn surfacing the result with
 *  enough context to remind the user what was originally asked. */
export interface AgentCompletedPayload extends AgentEventCommon {
  kind: 'agent-completed';
  /** The originating `pc_invoke_agent` call's run-id. */
  runId: ULID;
  /** Whatever the child returned (free-form text or JSON-encoded string). */
  result: string;
}

/** A background-dispatched agent failed. Orchestrator's handler protocol
 *  entry #5: surface failure + suggest a next step (retry / drop /
 *  hand-write). */
export interface AgentFailedPayload extends AgentEventCommon {
  kind: 'agent-failed';
  runId: ULID;
  /** One-line failure summary. */
  reason: string;
  /** Optional structured error code. Matches the values the orchestrator pod
   *  prompt's handler-protocol §5 documents. `error` stays as the catch-all
   *  for anything the runtime can't classify (e.g. unexpected exceptions). */
  cause:
    | 'timeout'
    | 'loop-cap'
    | 'depth-cap'
    | 'cancelled'
    | 'unknown-agent'
    | 'spawn-failed'
    | 'error'
    | null;
}

export type AgentChannelEventPayload =
  | AgentAsksOrchestratorPayload
  | AgentApprovalRequestPayload
  | AgentCompletedPayload
  | AgentFailedPayload;

// ─── MCP tool input / output shapes ───────────────────────────────────────

// pc_invoke_agent ─────────────────────────────────────────────────────────

/** `pc_invoke_agent` — dispatch an agent. ALWAYS async: returns immediately
 *  with the run handle; the terminal result arrives via the mailbox
 *  (`agent-completed` / `agent-failed`) + the deliverable door.
 *  M5 (ledger sync-invoke DELETE): ☠ `wait` flag + `PcInvokeAgentResultSync` —
 *  a sync mode that was typed but never wired (no handler read `wait`; the
 *  route hardcoded async). */
export interface PcInvokeAgentInput {
  /** Pod-row name (kebab-case). */
  name: string;
  /** Free-form input passed to the child as its first user message. */
  input: string;
  /** Optional: the work-item the child is operating on. Carried forward
   *  on every ask the child emits and on its terminal event. */
  parentWorkItemId?: ULID;
}

export type PcInvokeAgentResult = PcInvokeAgentResultAsync | PcInvokeAgentResultError;

/** The dispatch receipt — child is running; terminal event will land
 *  separately. */
export interface PcInvokeAgentResultAsync {
  ok: true;
  mode: 'async';
  sessionId: string;
  runId: ULID;
  startedAt: number;
}

export interface PcInvokeAgentResultError {
  ok: false;
  error: string;
  /** Optional structured cause for caller-side handling. */
  cause?: 'unknown-agent' | 'depth-cap' | 'loop-cap' | 'spawn-failed' | 'error';
}

// pc_ask_orchestrator ─────────────────────────────────────────────────────

/** `pc_ask_orchestrator` — THE pause-and-ask door (FD-6). Tool returns a
 *  pending-ask handle; the agent ends its turn naturally; runtime resumes via
 *  `--resume <sessionId>` once `pc_answer_pending` lands the answer, and
 *  writes the answer as the next user message. `options` (inherited from the
 *  deleted `pc_ask_user`) renders as a numbered list for the answerer. */
export interface PcAskOrchestratorInput {
  question: string;
  context?: string;
  options?: PendingAskOption[];
}

export interface PcAskOrchestratorResult {
  ok: true;
  pendingAskId: ULID;
  status: 'waiting';
}

// pc_request_approval ─────────────────────────────────────────────────────

/** `pc_request_approval` — explicit human-in-the-loop gate. Same pause
 *  semantics; rendered via the existing `ApprovalBubble` surface.
 *  Subsumes today's workflow approval node for non-workflow invocations. */
export interface PcRequestApprovalInput {
  decision: string;
  options: PendingAskOption[];
  context?: string;
}

export interface PcRequestApprovalResult {
  ok: true;
  pendingAskId: ULID;
  status: 'waiting';
}

// pc_answer_pending ───────────────────────────────────────────────────────

/** `pc_answer_pending` — orchestrator's tool to resume a paused agent.
 *  Re-spawns the agent with `--resume <sessionId>` and writes `answer` as
 *  the next user message. Idempotent against double-fire: status check on
 *  the row (`open` only) guards JSONL-replay re-delivery. */
export interface PcAnswerPendingInput {
  pendingAskId: ULID;
  answer: string;
  /** Who produced the answer. Drives the audit-trail row + the chat-side
   *  attribution ("orchestrator answered:" vs "user answered:"). */
  answeredBy: 'orchestrator' | 'user';
}

export type PcAnswerPendingResult =
  | PcAnswerPendingResultOk
  | PcAnswerPendingResultError;

export interface PcAnswerPendingResultOk {
  ok: true;
  sessionId: string;
  status: 'resuming';
}

export interface PcAnswerPendingResultError {
  ok: false;
  error: string;
  cause: 'unknown-pending-ask' | 'already-answered' | 'cancelled' | 'resume-failed' | 'error';
}
