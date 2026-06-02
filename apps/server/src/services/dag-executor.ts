// Section 19.4d — v2 DAG executor orchestration. Drives the pure 19.4c brain
// (@pc/workflows `dag/`) against injected live deps (spawn / work-item / review
// / persistence). Deps-injected so the control flow is unit-testable with
// fakes; the live wiring (createAgentWorkItem + spawnSubagent + worktree +
// broadcast + deliverReview) is supplied by apps/server at construction.
//
// Model: await-per-layer (matches PC's existing tick — `await Promise.all(ready)`).
//   advance(): loop — selectReady → dispatch non-review ready concurrently
//     (capped by max_concurrency) + await → settle → repeat. When only review
//     nodes are ready, pause (awaiting-review) and return; onReviewDecision()
//     resumes by re-running advance().

import type { ULID, WorkflowV2 } from '@pc/domain';
import {
  computeRunStatus,
  computeUpstreams,
  initDagState,
  markAwaitingReview,
  markRunning,
  markSkipped,
  applyReviewDecision,
  selectReady,
  settleNode,
  type RefResolver,
  type ReviewDecision,
  type RunStatus,
} from '@pc/workflows';

type Node = WorkflowV2.WorkflowNode;
type State = WorkflowV2.WorkflowDagState;

/** Per-dispatch context handed to deps. `carry` holds reject-edge wired values;
 *  `resolve` lets the dep render `$nodeId.output[.field]` in task/command bodies. */
export interface DagNodeContext {
  runId: ULID;
  rootWorkItemId: ULID | null;
  worktreePath: string | null;
  carry: Record<string, string>;
  resolve: RefResolver;
}

export interface NodeOutcome {
  state: 'completed' | 'failed';
  workItemId?: ULID;
  error?: string;
  /** Captured stdout for bash/script nodes — feeds `$nodeId.output` refs (F#1). */
  output?: string;
}

/** Live surfaces the executor needs. apps/server supplies the real impls; tests
 *  supply fakes. All async deps resolve when the node is terminal. */
export interface DagExecutorDeps {
  /** Build a `$nodeId.output[.field]` resolver against the current state (reads
   *  child work items). Rebuilt each tick so it sees freshly-settled nodes. */
  resolveRef(state: State): RefResolver;
  /** Create the child work item + spawn the pod; resolve when terminal. */
  dispatchAgent(node: WorkflowV2.AgentNode, ctx: DagNodeContext): Promise<NodeOutcome>;
  /** Card-move TRANSITION EFFECT (locked decision 1) — move the run-root card to
   *  `stage` without firing that stage's on-entry workflows. Applied after a step
   *  settles `completed` (its `move`) or on a reject kick-back (`reject.move`). */
  moveCard(stage: string): Promise<{ ok: boolean; error?: string }>;
  /** Post the review gate (orchestrator channel event / Human Review inbox). */
  requestReview(
    node: WorkflowV2.ReviewNode,
    ctx: DagNodeContext,
    bundle: { nodeId: string; output: string }[]
  ): Promise<void>;
  /** Persist DAG state + run status (+ broadcast). */
  persist(state: State, status: RunStatus, opts?: { lastReason?: string }): void;
  /** Append an observability event. */
  event(ev: { type: WorkflowV2.WorkflowEventType; nodeId?: string; data?: Record<string, unknown> }): void;
  /** External cancellation check (between layers). */
  isCancelled(): boolean;
  /** Route a ceiling-exceeded review to Human Review (Section 7). */
  holdForHuman(nodeId: string, reason: string): void;
  /** Workflow-engine redesign — fired once when the run finalizes as `failed`,
   *  carrying the derived failure reason. Delivers a notice to the human inbox +
   *  the project orchestrator (offline → persists, drains next pass). Optional so
   *  tests + the review/cancel paths don't have to wire it. */
  notifyRunFailed?(reason: string): void;
}

const DEFAULT_MAX_CONCURRENCY = 4;
const TICK_SAFETY = 1000;

function isReview(n: Node): n is WorkflowV2.ReviewNode {
  return n.kind === 'review';
}

export class DagExecutor {
  private readonly byId: Map<string, Node>;
  private readonly ctxBase: Omit<DagNodeContext, 'carry' | 'resolve'>;

  constructor(
    private readonly workflow: WorkflowV2.Workflow,
    private state: State,
    private readonly deps: DagExecutorDeps,
    ctxBase: Omit<DagNodeContext, 'carry' | 'resolve'>
  ) {
    this.byId = new Map(workflow.nodes.map((n) => [n.id, n]));
    this.ctxBase = ctxBase;
  }

  /** Fresh run from a clean state. */
  static start(
    workflow: WorkflowV2.Workflow,
    deps: DagExecutorDeps,
    ctxBase: Omit<DagNodeContext, 'carry' | 'resolve'>
  ): DagExecutor {
    return new DagExecutor(workflow, initDagState(workflow), deps, ctxBase);
  }

  /** Resume an existing run from persisted state. */
  static resume(
    workflow: WorkflowV2.Workflow,
    state: State,
    deps: DagExecutorDeps,
    ctxBase: Omit<DagNodeContext, 'carry' | 'resolve'>
  ): DagExecutor {
    return new DagExecutor(workflow, state, deps, ctxBase);
  }

  getState(): State {
    return this.state;
  }

  private ctx(resolve: RefResolver, carry: Record<string, string> = {}): DagNodeContext {
    return { ...this.ctxBase, carry, resolve };
  }

  /** Default Review Bundle = the review node's immediate upstreams' outputs. */
  private resolveBundle(
    node: WorkflowV2.ReviewNode,
    resolve: RefResolver
  ): { nodeId: string; output: string }[] {
    const sources =
      node.bundle_from && node.bundle_from.length > 0
        ? node.bundle_from
        : (computeUpstreams(this.workflow.nodes).get(node.id) ?? []);
    return sources.map((nodeId) => ({ nodeId, output: resolve(nodeId, undefined) }));
  }

  /**
   * Drive the DAG forward until it pauses (a review gate), completes, or fails.
   * Idempotent to call repeatedly (after a node settles externally, or a review
   * resolves) — it re-derives ready nodes from the persisted state each time.
   */
  async advance(): Promise<RunStatus> {
    for (let guard = 0; guard < TICK_SAFETY; guard++) {
      if (this.deps.isCancelled()) {
        this.deps.persist(this.state, 'cancelled' as RunStatus, { lastReason: 'cancelled' });
        return 'cancelled' as RunStatus;
      }

      const resolve = this.deps.resolveRef(this.state);
      const { ready, skips } = selectReady(this.workflow, this.state, resolve);

      for (const sk of skips) {
        this.state = markSkipped(this.state, sk.nodeId, sk.reason);
        this.deps.event({ type: 'node_skipped', nodeId: sk.nodeId, data: { reason: sk.reason } });
      }

      if (ready.length === 0) {
        if (skips.length > 0) continue; // skips may have unblocked downstream
        break; // no progress possible — fall through to finalize
      }

      const reviewReady = ready.filter((id) => isReview(this.byId.get(id)!));
      const runReady = ready.filter((id) => !isReview(this.byId.get(id)!));

      // Non-review nodes first: dispatch concurrently (capped), await, settle.
      if (runReady.length > 0) {
        await this.runLayer(runReady, resolve);
        this.persistRun(computeRunStatus(this.workflow, this.state));
        continue; // re-evaluate (a review may now be ready)
      }

      // Only review nodes ready → pause the run at the gate(s).
      for (const id of reviewReady) {
        const node = this.byId.get(id) as WorkflowV2.ReviewNode;
        this.state = markRunning(this.state, id);
        this.state = markAwaitingReview(this.state, id);
        const bundle = this.resolveBundle(node, resolve);
        await this.deps.requestReview(node, this.ctx(resolve), bundle);
        // Persist the assembled bundle into the audit log so the review surface
        // is durable + replayable without re-resolving upstream WIs (19.5).
        this.deps.event({ type: 'review_requested', nodeId: id, data: { bundle } });
      }
      this.deps.persist(this.state, 'awaiting-review');
      return 'awaiting-review';
    }

    return this.finalize();
  }

  private async runLayer(ids: string[], resolve: RefResolver): Promise<void> {
    const cap = this.workflow.max_concurrency ?? DEFAULT_MAX_CONCURRENCY;
    for (let i = 0; i < ids.length; i += cap) {
      const batch = ids.slice(i, i + cap);
      for (const id of batch) {
        this.state = markRunning(this.state, id);
        this.deps.event({ type: 'node_started', nodeId: id });
      }
      const outcomes = await Promise.all(
        batch.map(async (id) => {
          const node = this.byId.get(id)!;
          const carry = this.carryFor(id, resolve);
          try {
            // runLayer only ever sees non-review ready nodes (review nodes pause
            // via requestReview), and the only non-review kind is `agent`.
            if (node.kind !== 'agent') {
              return { id, outcome: { state: 'failed' as const, error: `unexpected node kind "${node.kind}" in run layer` } };
            }
            const outcome = await this.deps.dispatchAgent(node, this.ctx(resolve, carry));
            return { id, outcome };
          } catch (err) {
            return {
              id,
              outcome: { state: 'failed' as const, error: (err as Error).message },
            };
          }
        })
      );
      for (const { id, outcome } of outcomes) {
        this.state = settleNode(this.state, id, outcome);
        this.deps.event({
          type: outcome.state === 'completed' ? 'node_completed' : 'node_failed',
          nodeId: id,
          ...(outcome.error ? { data: { error: outcome.error } } : {}),
        });
        // Card-move TRANSITION EFFECT (locked decision 1) — a step that declares
        // `move` advances the run-root card on completion. Best-effort: a move
        // failure is logged but does not fail the (already-completed) step.
        const moved = this.byId.get(id)?.move;
        if (outcome.state === 'completed' && moved) {
          const res = await this.deps.moveCard(moved);
          this.deps.event({
            type: 'card_moved',
            nodeId: id,
            data: res.ok ? { stage: moved } : { stage: moved, error: res.error ?? 'move failed' },
          });
        }
      }
    }
  }

  /** Carry values wired from a reject edge that targets this node. `$self.output`
   *  resolves to the reviewer's reject notes (a review node's "output" IS its
   *  verdict — stashed in `state.rejectFeedback` by applyReviewDecision so it
   *  survives the loop-subtree reset); other `$nodeId.output` refs read upstream
   *  child WIs via the resolver. */
  private carryFor(nodeId: string, resolve: RefResolver): Record<string, string> {
    const carry: Record<string, string> = {};
    for (const n of this.workflow.nodes) {
      if (!isReview(n) || !n.reject || n.reject.back_to !== nodeId) continue;
      const feedback = this.state.rejectFeedback?.[n.id] ?? '';
      for (const [key, expr] of Object.entries(n.reject.carry ?? {})) {
        carry[key] = expr
          // `$self.output[.field]` → the reviewer's notes (replacer fn avoids
          // `$`-mangling if the feedback text itself contains `$`).
          .replace(/\$self\.output(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?/g, () => feedback)
          .replace(
            /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?/g,
            (_m, ref: string, field: string | undefined) => resolve(ref, field)
          );
      }
    }
    return carry;
  }

  /**
   * Resolve a review decision (called by the server when the orchestrator/user
   * approves or rejects). Applies it to state, then advances (approve/kickback)
   * or holds for human (ceiling). Returns the new run status.
   */
  async onReviewDecision(reviewNodeId: string, decision: ReviewDecision): Promise<RunStatus> {
    const outcome = applyReviewDecision(this.workflow, this.state, reviewNodeId, decision);
    this.state = outcome.state;
    this.deps.event({
      type: decision.kind === 'approve' ? 'review_approved' : 'review_rejected',
      nodeId: reviewNodeId,
    });

    if (outcome.heldForHuman) {
      // Ceiling reached: the review node is now `failed`. Surface it to Human
      // Review (Section 7) for visibility, then advance — downstream nodes whose
      // only path ran through the failed review get skipped, and the run
      // finalizes to `failed`.
      this.deps.event({ type: 'iteration_ceiling_hit', nodeId: reviewNodeId });
      this.deps.holdForHuman(reviewNodeId, 'reject iteration ceiling reached');
    } else if (outcome.kickedBack) {
      // Card-move transition effect on kick-back (locked decision 1) — e.g. a QA
      // gate reject moves the card back to the build stage before the loop re-runs.
      const reviewNode = this.byId.get(reviewNodeId);
      const moved = reviewNode && isReview(reviewNode) ? reviewNode.reject?.move : undefined;
      if (moved) {
        const res = await this.deps.moveCard(moved);
        this.deps.event({
          type: 'card_moved',
          nodeId: reviewNodeId,
          data: res.ok ? { stage: moved } : { stage: moved, error: res.error ?? 'move failed' },
        });
      }
    }
    return this.advance();
  }

  private finalize(): RunStatus {
    const status = computeRunStatus(this.workflow, this.state);
    if (status === 'completed') this.deps.event({ type: 'workflow_completed' });
    else if (status === 'failed') this.deps.event({ type: 'workflow_failed' });
    this.persistRun(status);
    // Workflow-engine redesign — a failed run notifies the human inbox + the
    // project orchestrator (durable; survives an offline orchestrator). Fired
    // after persist so the run row is already terminal when the notice lands.
    if (status === 'failed') this.deps.notifyRunFailed?.(this.deriveFailureReason());
    return status;
  }

  /** Persist a (possibly terminal) status, deriving lastReason from failed
   *  nodes so a `failed` run is debuggable (the v1 path always passed `null`,
   *  which left reject-ceiling and agent-failure runs opaque in Activity). */
  private persistRun(status: RunStatus): void {
    const opts = status === 'failed' ? { lastReason: this.deriveFailureReason() } : undefined;
    this.deps.persist(this.state, status, opts);
  }

  private deriveFailureReason(): string {
    const failed: string[] = [];
    for (const node of this.workflow.nodes) {
      const rec = this.state.nodes[node.id];
      if (rec?.state === 'failed') {
        failed.push(`${node.id}: ${rec.error ?? 'unknown error'}`);
      }
    }
    return failed.length > 0 ? failed.join('; ') : 'workflow failed';
  }
}
