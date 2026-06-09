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

/** Node kinds — FD-9 (M6 slice B) + pc-pty-chat-270: five visible step kinds,
 *  each doing one thing. `agent` (hand a job to an agent) · `review`
 *  (human-judgment gate; `reviewer` = human | orchestrator) · `move` (move the
 *  run-root card — a step drawn in the graph, NOT a hidden property) · `loop`
 *  (the one retry construct: a review's reject target; counts iterations up to a
 *  ceiling) · `merge` (engine-executed git merge into dev, positive-receipt
 *  verified; conflict parks the run at a durable review gate).
 *  What the graph shows = what happens. */
export const WORKFLOW_NODE_KINDS = [
  'agent',
  'review',
  'move',
  'loop',
  'merge',
] as const;
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

/** The single review kind. (Was two; unified.) Carries `reviewer`, a `reject`
 *  back-edge, and `bundle_from`. */
export const REVIEW_NODE_KINDS = ['review'] as const;
export type ReviewNodeKind = (typeof REVIEW_NODE_KINDS)[number];

/** Who a review step waits on. `human` → the user's inbox; `orchestrator` → the
 *  project orchestrator's inbox. Both pause the run durably until a decision. */
export const REVIEWERS = ['human', 'orchestrator'] as const;
export type Reviewer = (typeof REVIEWERS)[number];

// ---------------------------------------------------------------------------
// Triggers — ☠ DELETED (M6 / FD-10, 2026-06-04). Workflows do not declare
// triggers. Exactly two ways a run starts: the UI "Run now" button and the
// orchestrator's `pc_fire_workflow` tool — both land on the one fire route,
// optionally targeting an existing card via `workItemId`. The stage-on-entry
// machinery (a card entering a stage starts a workflow) was a hidden tripwire
// and is gone; schedule/event were validated-but-never-implemented vapor. If
// automation returns it comes back deliberately — the orchestrator noticing
// a move and CHOOSING to fire, keeping one brain in charge.
// ---------------------------------------------------------------------------

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

// ☠ RetryPolicy DELETED (M6 slice B) — it was dead schema: validated at save,
// documented in the builder prompt, implemented by NOTHING. An author could
// write a retry that silently never happened. The Loop step is the ONE retry
// construct.
// ☠ RejectEdge DELETED (M6 slice B / FD-9) — the reject kick-back's mechanics
// (back_to · ceiling · carry) moved onto the visible `loop` node; the
// on-reject card move (`reject.move`) died whole (the card moves only on the
// forward path, via explicit Move steps).

/** Fields common to every node. */
export interface WorkflowNodeBase {
  id: string;
  /** Declared input ports. Each entry binds a named input to a specific upstream
   *  output via a `$nodeId.output[.field]` / `$root.output[.field]` ref (a plain
   *  string with no `$` is a literal). The bound value is rendered into the
   *  node's `task`/`prompt` wherever `{{name}}` appears — so the wiring from one
   *  step's output to the next step's input is DECLARED + validated at save
   *  ("Saved ⇒ runnable": every ref must point at a strictly-earlier step, and
   *  every `{{name}}` placeholder must match a key here), not buried in prose.
   *  The upstream output is its CONTRACT DELIVERABLE (the one output slot). */
  input?: Record<string, string>;
  /** Forward edges — downstream node ids. Absent/empty = terminal node.
   *  For review nodes this is the on-approve path. */
  next?: string[];
  /** Skip-if-false guard. `$nodeId.output[.field] OP 'val'`, with `&&`/`||`.
   *  Validated at save (19.6); fail-closed (unparseable → skip). */
  when?: string;
  /** Join semantics over the edges pointing into this node. Default all_success. */
  trigger_rule?: TriggerRule;
  /** Hard ceiling (ms). Agent nodes: wall-clock ceiling (P9 remapped the old
   *  idle meaning — silence escalates, it never executes). Applied by the
   *  executor, not stored when unset. */
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

/** Unified review step (workflow-engine redesign). Pauses the run durably until
 *  a decision lands in an inbox — the user's (`reviewer: 'human'`) or the project
 *  orchestrator's (`reviewer: 'orchestrator'`). On approve, follows `next`; on
 *  reject, routes to the named Loop step. Same contract for both flavors. */
export interface ReviewNode extends WorkflowNodeBase {
  kind: 'review';
  /** Which inbox the run waits in. */
  reviewer: Reviewer;
  /** What to review. Supports substitution. */
  prompt?: string;
  /** Aggregate these nodes' outputs into one review artifact (Review Bundle,
   *  19.5). Default = the node's immediate upstreams (inverse of `next`). */
  bundle_from?: string[];
  /** On reject, route to this `loop` node (FD-9 — the loop is a drawn step).
   *  Omitted = a reject FAILS this review node (nowhere to kick back to). */
  reject?: string;
}

/** Move card step (FD-9 — a VISIBLE step, replacing the old hidden `move`
 *  property). When this step runs, the run-root card moves to `stage`. A
 *  failed move fails the step honestly (it's a real step, not best-effort). */
export interface MoveNode extends WorkflowNodeBase {
  kind: 'move';
  /** Destination stage id (from the project's stages — the id, never the name). */
  stage: string;
}

/** Loop step (FD-9 — the ONE retry construct, drawn in the graph). The reject
 *  target of exactly one review node. On each reject under the ceiling it
 *  resets the `back_to` → review subtree to pending and re-runs it with the
 *  reviewer's feedback; at the ceiling the work escalates to a human.
 *  Deliberately NOT a flow node: no `next`/`when`/`input` — its routing is
 *  fixed (under ceiling → back_to; at ceiling → human). */
export interface LoopNode {
  id: string;
  kind: 'loop';
  /** Node id to re-run from (must be an upstream of the owning review). */
  back_to: string;
  /** Cap on iterations per run. Default 3. `null` = unlimited. */
  max_iterations?: number | null;
  /** Values wired into the back_to node's re-run. e.g.
   *  `{ feedback: '$self.output' }`. `$self` = the owning review's verdict. */
  carry?: Record<string, string>;
  /** Visualizer position override (same semantics as WorkflowNodeBase). */
  position?: { x: number; y: number };
  // Flow-node fields a loop deliberately CANNOT carry (typed `never` so generic
  // `node.next` readers still compile while authoring them is a type error).
  next?: never;
  when?: never;
  trigger_rule?: never;
  input?: never;
  timeout?: never;
}

/** Engine-executed git merge into `dev` (pc-pty-chat-270). The engine runs
 *  `git merge --no-ff <run-branch>`, asserts the branch tip is an ancestor of
 *  dev (positive receipt #1), pushes, and asserts `origin/dev == dev` (positive
 *  receipt #2). A conflict parks the run at a durable review gate (reviewer =
 *  `conflict_reviewer`, default `'orchestrator'`) — approving re-runs the step
 *  idempotently. The run never advances on an unverified side-effect.
 *
 *  Requires the workflow to have `worktree: 'auto'` (or no `worktree` field,
 *  which defaults to `'auto'`). Validated at save time. */
export interface MergeNode extends WorkflowNodeBase {
  kind: 'merge';
  /** The only valid merge target. Reserved for future multi-branch support. */
  target: 'dev';
  /** Who reviews if there's a merge conflict. Defaults to `'orchestrator'`.
   *  `'orchestrator'` keeps the gate off the user's clickable inbox
   *  (pc-pty-chat-267). `'human'` surfaces it there directly. */
  conflict_reviewer?: 'orchestrator' | 'human';
  /** Stage id to move the run-root card to on conflict — board visibility only,
   *  never a trigger (stage-entry firing is deleted). Optional. */
  on_conflict_stage?: string;
}

export type WorkflowNode = AgentNode | ReviewNode | MoveNode | LoopNode | MergeNode;

// Type guards
export function isReviewNode(n: WorkflowNode): n is ReviewNode {
  return n.kind === 'review';
}
export function isMoveNode(n: WorkflowNode): n is MoveNode {
  return n.kind === 'move';
}
export function isLoopNode(n: WorkflowNode): n is LoopNode {
  return n.kind === 'loop';
}
export function isMergeNode(n: WorkflowNode): n is MergeNode {
  return n.kind === 'merge';
}

// ---------------------------------------------------------------------------
// Workflow (authored YAML shape)
// ---------------------------------------------------------------------------

export interface Workflow {
  /** Slug — author-readable, immutable after create. */
  id: string;
  name: string;
  description?: string;
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
  /** Per-instance idempotency token for this review gate. Set when the gate
   *  arms (markAwaitingReview), cleared when a decision commits successfully.
   *  Token = `i${iteration}` or `i${iteration}:escalated` — mirrors the
   *  mailbox idempotency key. Absent = gate is not armed (or legacy run that
   *  predates this field). Persisted in dagState so it survives a reload
   *  between decision and any retry (R3). */
  openReviewInstance?: string;
}

/** DAG execution state for one run. JSON-encoded into the sidecar row. */
export interface WorkflowDagState {
  /** node id → runtime record. */
  nodes: Record<string, NodeRunRecord>;
  /** Loop iteration counts, keyed by the LOOP node id (M6 slice B — the loop
   *  owns the ceiling). Compared against `LoopNode.max_iterations` to trigger
   *  the ceiling hold. (Pre-M6 runs keyed these by review node id — all
   *  terminal, never resumed.) */
  rejectIterations?: Record<string, number>;
  /** Latest reviewer reject notes, keyed by review node id. Survives the
   *  loop-subtree reset (which wipes per-node records) so a loop's
   *  `carry: { x: $self.output[.field] }` injects the reviewer's feedback into
   *  the re-run `back_to` node. A review node's "output" IS its verdict. */
  rejectFeedback?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Event log — `workflow_run_events`: THE RUN DIARY (M3a/FD-11/FD-13). Every
// line flows through WorkflowRunMutationGateway.appendRunEvent (event row +
// `workflow.run.event` outbox fact, one txn) — direct repo writes are gated.
// Execution still resumes from the children's terminal states + dag_state;
// state-projection-from-the-diary lands with the M6 step-model rebuild.
// ---------------------------------------------------------------------------

export const WORKFLOW_EVENT_TYPES = [
  'workflow_started',
  'workflow_completed',
  'workflow_failed',
  'workflow_cancelled',
  /** M3a — the server died/restarted with the run in flight; boot fail-closed
   *  it (`data.reason`). The diary line the old fail-close never wrote. */
  'run_interrupted',
  'node_started',
  'node_completed',
  'node_failed',
  'node_skipped',
  /** M3a — a node's worker dispatch landed; `data.agentRunId` +
   *  `data.workItemId` cross-link the diary to the agent run (FD-11 debugging). */
  'agent_dispatched',
  'review_requested',
  'review_approved',
  'review_rejected',
  'iteration_ceiling_hit',
  /** M6 slice C (FD-11 req 2/3) — a failed run was resumed from its failed
   *  step(s); `data.resetNodes` + `data.defChanged` (the repair loop re-froze
   *  the CURRENT definition as the run's new snapshot). */
  'run_resumed',
  /** A move STEP fired (FD-9 — card-move is a drawn step since M6 slice B). */
  'card_moved',
  /** pc-pty-chat-270: the engine ran `git merge --no-ff` into dev, verified
   *  the commit landed, pushed, and verified origin/dev == dev. */
  'git_merged',
  /** pc-pty-chat-270: the engine attempted a merge but hit a conflict (or a
   *  rejected push). The run is paused at a review gate pending resolution. */
  'git_conflict',
] as const;
export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

export interface WorkflowRunEvent {
  type: WorkflowEventType;
  nodeId?: string;
  /** Free-form per-event payload (reason, iteration, durationMs, …). */
  data?: Record<string, unknown>;
  at: number;
}
