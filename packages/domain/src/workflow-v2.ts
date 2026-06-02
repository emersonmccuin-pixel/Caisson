// Section 19 — Workflow rebuild from Archon. v2 domain types.
//
// Coexists with the old workflow.ts / workflow-run.ts / workflow-catalog.ts /
// workflow-edges.ts / workflow-ports.ts system until 19.12 culls it. Exported
// from the barrel under the `WorkflowV2` namespace to avoid name collisions
// (old BashNode/ScriptNode/DagNode/Workflow/OrchestratorReviewNode all still live).
//
// Design (locked 19.2, see buildout/workflow-rebuild.md):
//  - Forward edges via `next` (NOT Archon's `depends_on`). Matches the one-
//    socket-per-side visualizer (out → in). Executor inverts `next` to compute
//    upstreams for topo-sort + trigger_rule. Reject back-edges are excluded
//    from topo.
//  - Terminal node = no `next`. No `end` kind (keeps the locked 5-kind set).
//  - Review nodes: `next` = on-approve forward flow; `reject` = kick-back back-edge.
//  - Each node's output IS its child work item (agent-outputs.md). `$nodeId.output`
//    resolves to "read child WI body/fields" — there is no in-memory output map
//    as source of truth (see port map: "stateless over work items").

import type { ExpectedOutput } from './contract.ts';
import type { VerificationTier } from './contract.ts';

// ---------------------------------------------------------------------------
// Node kinds
// ---------------------------------------------------------------------------

/** v1 node set. Five kinds + move-work-item. `loop` + `cancel` dropped (locks 3 + 13). */
export const WORKFLOW_NODE_KINDS = [
  'agent',
  'bash',
  'script',
  'human-review',
  'orchestrator-review',
  'move-work-item',
] as const;
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

export function isWorkflowNodeKind(value: unknown): value is WorkflowNodeKind {
  return typeof value === 'string' && (WORKFLOW_NODE_KINDS as readonly string[]).includes(value);
}

/** Review kinds carry a `reject` back-edge + `bundle_from`. */
export const REVIEW_NODE_KINDS = ['human-review', 'orchestrator-review'] as const;
export type ReviewNodeKind = (typeof REVIEW_NODE_KINDS)[number];

// ---------------------------------------------------------------------------
// Triggers — four in schema from day one (lock 10). UI exposes manual +
// stage-on-entry only in v1 (lock 11); schedule + event are schema-complete
// but UI-deferred to the follow-up section.
// ---------------------------------------------------------------------------

export const TRIGGER_KINDS = ['manual', 'stage-on-entry', 'schedule', 'event'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Fired from the UI "Run now" button or `pc_run_workflow`. */
export interface ManualTrigger {
  kind: 'manual';
}

/** Fired when a work item enters `stage`. Forward moves only by default;
 *  opt into backward moves with `also_fire_on_regression` (lock 2). */
export interface StageOnEntryTrigger {
  kind: 'stage-on-entry';
  stage: string;
  also_fire_on_regression?: boolean;
}

/** Schema-complete, UI-deferred. In-process cron registry (follow-up). */
export interface ScheduleTrigger {
  kind: 'schedule';
  cron: string;
}

/** Schema-complete, UI-deferred. Channel-server webhook route (follow-up).
 *  `when` is a `$trigger.event.*` predicate in the when: grammar. */
export interface EventTrigger {
  kind: 'event';
  source: string;
  when?: string;
}

export type WorkflowTrigger =
  | ManualTrigger
  | StageOnEntryTrigger
  | ScheduleTrigger
  | EventTrigger;

// ---------------------------------------------------------------------------
// Shared node bits
// ---------------------------------------------------------------------------

/** Upstream join semantics for a node with multiple `next`-edges pointing into
 *  it. Default `all_success`. Kept in schema; builder UI hides it in v1 (the
 *  reject-edge covers branching for the common case). */
export const TRIGGER_RULES = [
  'all_success',
  'one_success',
  'all_done',
  'none_failed_min_one_success',
] as const;
export type TriggerRule = (typeof TRIGGER_RULES)[number];

/** Per-node retry. Omitted = no retry (single attempt, fail-fast). */
export interface RetryPolicy {
  /** Total attempts including the first. Default 1. */
  max_attempts: number;
  /** Causes that trigger a retry. Default `['failed']`. */
  on?: ('failed' | 'timeout')[];
  /** Wait between attempts (ms). Exponential backoff applied by the executor. */
  delay_ms?: number;
}

/** Reject kick-back — the single looping primitive (lock 1). Lives on review
 *  nodes only. Per-edge per-run iteration count (lock 4). */
export interface RejectEdge {
  /** Node id to re-run with the reviewer's feedback. */
  back_to: string;
  /** Cap on kick-backs for this edge per run. Default 3. `null` = unlimited.
   *  Exceeding it escalates to a human-review hold (lock 4). */
  max_iterations?: number | null;
  /** Values wired into the back_to node's next run. e.g.
   *  `{ feedback: '$self.output.notes' }`. `$self` = this review node. */
  carry?: Record<string, string>;
}

/** Fields common to every node. */
export interface WorkflowNodeBase {
  id: string;
  /** Forward edges — downstream node ids. Absent/empty = terminal node.
   *  For review nodes this is the on-approve path. */
  next?: string[];
  /** Skip-if-false guard. `$nodeId.output[.field] OP 'val'`, with `&&`/`||`.
   *  Validated at save (19.6); fail-closed (unparseable → skip). */
  when?: string;
  /** Join semantics over the edges pointing into this node. Default all_success. */
  trigger_rule?: TriggerRule;
  /** Per-node retry policy. Omitted = no retry. */
  retry?: RetryPolicy;
  /** Hard ceiling (ms). bash/script: wall-clock kill (SIGKILL). agent: idle
   *  ceiling (no JSONL activity). Default idle 5 min / wall-clock 2 h for agent
   *  nodes; applied by the executor, not stored when unset. */
  timeout?: number;
  /** Visualizer-layer position override. Persisted so user drags survive a
   *  reload and the agent-author can read positions between turns
   *  (sync-model-A, Section 19 lock 8). When absent, the visualizer falls back
   *  to the auto-layout (elkjs). Presentational only — the executor ignores it. */
  position?: { x: number; y: number };
}

// ---------------------------------------------------------------------------
// Node variants
// ---------------------------------------------------------------------------

/** Dispatches a pod against a child work item. The node's `task` becomes the
 *  child WI body; `expected_output` derives the child's acceptance criteria
 *  (agent-outputs.md). `$nodeId.output` downstream = read this child WI. */
export interface AgentNode extends WorkflowNodeBase {
  kind: 'agent';
  /** Pod name — a stock or project pod. */
  agent: string;
  /** Child work item body / instructions. Supports `$nodeId.output[.field]`
   *  + `$trigger.*` + `$carry.*` substitution. */
  task: string;
  /** Output contract → derives the child WI's AC. Defaults to the pod's
   *  default expected_output when omitted (getPodDefaultExpectedOutput). */
  expected_output?: ExpectedOutput;
  /** AC verification tier for this node's child WI. Default `auto`. */
  verification_tier?: VerificationTier;
}

/** Runs a shell command in the run's worktree, path-guarded. SIGKILL on
 *  timeout. No AI, no child-WI dispatch (output = `{stdout, stderr, exitCode}`). */
export interface BashNode extends WorkflowNodeBase {
  kind: 'bash';
  /** Shell body. Supports `$nodeId.output[.field]` (bash-escaped). */
  bash: string;
}

/** Runs a TS (node) or Python script in the run's worktree. SIGKILL on timeout.
 *  PC convention is node/python (NOT Archon's bun/uv — port-map open Q #1). */
export interface ScriptNode extends WorkflowNodeBase {
  kind: 'script';
  script: string;
  runtime: 'node' | 'python';
}

/** Pauses the run; queues in the Human Review inbox (Section 7). On approve,
 *  follows `next`; on reject, kicks back via `reject`. */
export interface HumanReviewNode extends WorkflowNodeBase {
  kind: 'human-review';
  /** What the user should review. Supports substitution. */
  prompt?: string;
  /** Aggregate these nodes' outputs into one review artifact (Review Bundle,
   *  19.5). Default = the node's immediate upstreams (inverse of `next`). */
  bundle_from?: string[];
  reject?: RejectEdge;
}

/** Pauses the run; wakes the orchestrator via channel event. On approve,
 *  follows `next`; on reject, kicks back via `reject`. */
export interface OrchestratorReviewNode extends WorkflowNodeBase {
  kind: 'orchestrator-review';
  prompt?: string;
  bundle_from?: string[];
  reject?: RejectEdge;
}

/** Moves the run-root work item to a different stage. Does NOT fire
 *  stage-on-entry workflows on the destination (avoids trigger loops).
 *  On success the node's `output` is the new stage id. */
export interface MoveWorkItemNode extends WorkflowNodeBase {
  kind: 'move-work-item';
  /** Destination stage id (required, non-empty). */
  to_stage: string;
  /** Explicit opt-in to move into a stage that has its own stage-on-entry
   *  workflow (which the move will silently skip). */
  allow_stage_workflow_skip?: boolean;
}

export type WorkflowNode =
  | AgentNode
  | BashNode
  | ScriptNode
  | HumanReviewNode
  | OrchestratorReviewNode
  | MoveWorkItemNode;

// Type guards
export function isAgentNode(n: WorkflowNode): n is AgentNode {
  return n.kind === 'agent';
}
export function isBashNode(n: WorkflowNode): n is BashNode {
  return n.kind === 'bash';
}
export function isScriptNode(n: WorkflowNode): n is ScriptNode {
  return n.kind === 'script';
}
export function isReviewNode(n: WorkflowNode): n is HumanReviewNode | OrchestratorReviewNode {
  return n.kind === 'human-review' || n.kind === 'orchestrator-review';
}

// ---------------------------------------------------------------------------
// Workflow (authored YAML shape)
// ---------------------------------------------------------------------------

export interface Workflow {
  /** Slug — author-readable, immutable after create. */
  id: string;
  name: string;
  description?: string;
  /** At least one trigger. `manual` is the implicit fallback if empty. */
  triggers: WorkflowTrigger[];
  nodes: WorkflowNode[];
  /** `auto` (default) = runtime creates/reuses a worktree bound to the run;
   *  `none` = no worktree (bash/script nodes then run in the project dir). */
  worktree?: 'auto' | 'none';
  /** When true, all fire-paths skip this workflow. Default false. */
  disabled?: boolean;
  /** Max nodes run concurrently per topological layer. Default 4 (PC lock). */
  max_concurrency?: number;
}

// ---------------------------------------------------------------------------
// Runtime state — held in the `workflow_runs` sidecar (19.3). The work items
// are the durable source of truth for node outputs; this state holds DAG
// bookkeeping (which nodes ran, iteration counts) that isn't derivable from
// the work items alone.
// ---------------------------------------------------------------------------

export const WORKFLOW_RUN_STATUSES = [
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const NODE_RUN_STATES = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'awaiting-review',
] as const;
export type NodeRunState = (typeof NODE_RUN_STATES)[number];

/** Per-node runtime record in the sidecar's DAG state. */
export interface NodeRunRecord {
  state: NodeRunState;
  /** Child work item id (agent nodes; review nodes that materialise a WI). */
  workItemId?: string;
  /** Times this node has been (re-)dispatched. Bumped on reject kick-back. */
  iteration?: number;
  /** Reason when `state` is `failed`. */
  error?: string;
  /** Captured stdout for bash/script nodes (truncated). Lets `$nodeId.output`
   *  refs resolve to a real value instead of empty string — see F#1. Agent
   *  nodes resolve via `workItemId` → child work-item body and don't use this. */
  output?: string;
  startedAt?: number;
  endedAt?: number;
}

/** DAG execution state for one run. JSON-encoded into the sidecar row. */
export interface WorkflowDagState {
  /** node id → runtime record. */
  nodes: Record<string, NodeRunRecord>;
  /** Reject-edge kick-back counts, keyed by the review node id owning the edge.
   *  Compared against `RejectEdge.max_iterations` to trigger the ceiling hold. */
  rejectIterations?: Record<string, number>;
  /** Latest reviewer reject notes, keyed by review node id. Survives the
   *  loop-subtree reset (which wipes per-node records) so a reject edge's
   *  `carry: { x: $self.output[.field] }` injects the reviewer's feedback into
   *  the re-dispatched `back_to` node. A review node's "output" IS its verdict. */
  rejectFeedback?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Event log — `workflow_run_events` (19.3). OBSERVABILITY/AUDIT ONLY. Resume
// reads the children's terminal states, NOT this log (see port map).
// ---------------------------------------------------------------------------

export const WORKFLOW_EVENT_TYPES = [
  'workflow_started',
  'workflow_completed',
  'workflow_failed',
  'workflow_cancelled',
  'node_started',
  'node_completed',
  'node_failed',
  'node_skipped',
  'review_requested',
  'review_approved',
  'review_rejected',
  'iteration_ceiling_hit',
] as const;
export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

export interface WorkflowRunEvent {
  type: WorkflowEventType;
  nodeId?: string;
  /** Free-form per-event payload (reason, iteration, durationMs, …). */
  data?: Record<string, unknown>;
  at: number;
}
