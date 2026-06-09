// Section 19.4d — v2 DAG executor orchestration. Drives the pure 19.4c brain
// (@pc/workflows `dag/`) against injected live deps (spawn / work-item / review
// / persistence). Deps-injected so the control flow is unit-testable with
// fakes; the live wiring (createAgentWorkItem + agent dispatch + worktree +
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
  type ReviewRejected,
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
  /** Move the run-root card to `stage` — the body of a `move` STEP (FD-9: a
   *  drawn step, not a hidden property). A failed move fails the step. */
  moveCard(stage: string): Promise<{ ok: boolean; error?: string }>;
  /** Execute the git merge for a `merge` node (pc-pty-chat-270 Chunk B).
   *  Reads git state first (idempotent reconcile), then merge+verify+push+verify.
   *  `merged`   → node completes, advance proceeds;
   *  `conflict` → arm a review gate via requestReview, pause the run;
   *  `failed`   → fail the node (hard git or infra error). */
  mergeToDev(
    node: WorkflowV2.MergeNode,
    ctx: DagNodeContext,
  ): Promise<{ outcome: 'merged' | 'conflict' | 'failed'; error?: string }>;
  /** Post the review gate (orchestrator mailbox turn / Human Inbox card).
   *  `opts.iteration` = the owning loop's reject count (keys the delivery's
   *  idempotency so a re-review after a loop kick-back delivers AGAIN — FD-8);
   *  `opts.escalated` = the M6-C ceiling re-post (a human gate regardless of
   *  the authored reviewer). */
  requestReview(
    node: WorkflowV2.ReviewNode,
    ctx: DagNodeContext,
    bundle: { nodeId: string; output: string }[],
    opts: { iteration: number; escalated: boolean }
  ): Promise<void>;
  /** Persist DAG state + run status (+ broadcast). */
  persist(state: State, status: RunStatus, opts?: { lastReason?: string }): void;
  /** Append an observability event. */
  event(ev: { type: WorkflowV2.WorkflowEventType; nodeId?: string; data?: Record<string, unknown> }): void;
  /** External cancellation check (between layers). */
  isCancelled(): boolean;
  /** Workflow-engine redesign — fired once when the run finalizes as `failed`,
   *  carrying the derived failure reason. Delivers a notice to the human inbox +
   *  the project orchestrator (offline → persists, drains next pass). Optional so
   *  tests + the review/cancel paths don't have to wire it. */
  notifyRunFailed?(reason: string): void;
  /** Fired once each time a run finalizes as `completed`. The delivery
   *  (deliverWorkflowFirstRunReview in index.ts) keys its mailbox message
   *  `workflow-first-run-review:<workflowId>`, so the orchestrator is nudged to
   *  run the workflow-doctor exactly once per workflow — on its first
   *  completion. Optional so tests + the review/cancel paths needn't wire it. */
  notifyRunCompleted?(): void;
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

  /** The reject count of the loop this review's `reject` names (0 on the first
   *  pass / when the review has no loop). Keys re-review delivery idempotency. */
  private reviewIteration(node: WorkflowV2.ReviewNode): number {
    return node.reject ? (this.state.rejectIterations?.[node.reject] ?? 0) : 0;
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
        // M6 slice C — a cancel can land WHILE the layer was in flight (the
        // route cancels the child agent runs, which resolve as failed here).
        // Never let the advance loop overwrite the cancelled status.
        if (this.deps.isCancelled()) {
          this.deps.persist(this.state, 'cancelled' as RunStatus, { lastReason: 'cancelled' });
          return 'cancelled' as RunStatus;
        }
        const layerStatus = computeRunStatus(this.workflow, this.state);
        // pc-pty-chat-270 Chunk B step 5: a merge node armed a conflict gate
        // inside runLayer — persist and return now instead of continuing the
        // advance loop (which would fall through to finalize and persist twice).
        if (layerStatus === 'awaiting-review') {
          this.deps.persist(this.state, 'awaiting-review');
          return 'awaiting-review';
        }
        this.persistRun(layerStatus);
        continue; // re-evaluate (a review may now be ready)
      }

      // Only review nodes ready → pause the run at the gate(s).
      for (const id of reviewReady) {
        const node = this.byId.get(id) as WorkflowV2.ReviewNode;
        this.state = markRunning(this.state, id);
        // Stamp the instance token = i${iteration}: the serialization guard in
        // applyReviewDecision checks this token is present before accepting a
        // decision. Token mirrors the mailbox idempotency key (FD-8 / build-plan
        // step 1). `reviewIteration` is read AFTER markRunning (which doesn't
        // change rejectIterations) so iteration is accurate.
        const iteration = this.reviewIteration(node);
        this.state = markAwaitingReview(this.state, id, `i${iteration}`);
        const bundle = this.resolveBundle(node, resolve);
        await this.deps.requestReview(node, this.ctx(resolve), bundle, {
          iteration,
          escalated: false,
        });
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
      // `null` outcome = merge conflict: the batch function arms the gate state;
      // the settle loop posts the review gate and skips settleNode.
      const outcomes = await Promise.all(
        batch.map(async (id): Promise<{ id: string; outcome: NodeOutcome | null }> => {
          const node = this.byId.get(id)!;
          try {
            // runLayer sees non-review, non-loop ready nodes (reviews pause via
            // requestReview; loops never dispatch). Run kinds: agent, move, merge.
            if (node.kind === 'move') {
              const res = await this.deps.moveCard(node.stage);
              this.deps.event({
                type: 'card_moved',
                nodeId: id,
                data: res.ok
                  ? { stage: node.stage }
                  : { stage: node.stage, error: res.error ?? 'move failed' },
              });
              // FD-9: the move is a real step — a failed move fails it honestly.
              return res.ok
                ? { id, outcome: { state: 'completed' as const } }
                : { id, outcome: { state: 'failed' as const, error: `card move to "${node.stage}" failed: ${res.error ?? 'unknown error'}` } };
            }
            // pc-pty-chat-270 Chunk B step 5: merge node — THREE outcomes.
            // This is the ONE non-review node that can pause the run, kept
            // NARROW: only merge nodes, only via the existing requestReview door.
            if (node.kind === 'merge') {
              const r = await this.deps.mergeToDev(node, this.ctx(resolve));
              if (r.outcome === 'merged') {
                return { id, outcome: { state: 'completed' as const } };
              }
              if (r.outcome === 'failed') {
                return { id, outcome: { state: 'failed' as const, error: r.error ?? 'merge failed' } };
              }
              // conflict: signal the settle loop to arm a review gate below.
              return { id, outcome: null };
            }
            if (node.kind !== 'agent') {
              return { id, outcome: { state: 'failed' as const, error: `unexpected node kind "${node.kind}" in run layer` } };
            }
            const carry = this.carryFor(id, resolve);
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
        if (outcome === null) {
          // Merge conflict: arm a review gate via the existing requestReview door
          // (same path as review nodes). ONE door — no parallel pause path.
          const mergeNode = this.byId.get(id) as WorkflowV2.MergeNode;
          const reviewer: WorkflowV2.Reviewer = mergeNode.conflict_reviewer ?? 'orchestrator';
          const iteration = 0;
          this.state = markAwaitingReview(this.state, id, `i${iteration}`);
          const syntheticReview: WorkflowV2.ReviewNode = {
            kind: 'review',
            id: mergeNode.id,
            reviewer,
            prompt: `Merge conflict: resolve the conflict in the run's worktree, commit the result, then approve to retry the merge step.`,
            next: mergeNode.next,
          };
          await this.deps.requestReview(syntheticReview, this.ctx(resolve), [], {
            iteration,
            escalated: false,
          });
          this.deps.event({ type: 'review_requested', nodeId: id, data: { conflict: true } });
          continue;
        }
        this.state = settleNode(this.state, id, outcome);
        this.deps.event({
          type: outcome.state === 'completed' ? 'node_completed' : 'node_failed',
          nodeId: id,
          ...(outcome.error ? { data: { error: outcome.error } } : {}),
        });
      }
    }
  }

  /** Carry values wired from a loop node whose `back_to` targets this node.
   *  `$self.output` resolves to the OWNING review's reject notes (a review's
   *  "output" IS its verdict — stashed in `state.rejectFeedback` by
   *  applyReviewDecision so it survives the loop-subtree reset); other
   *  `$nodeId.output` refs read upstream child WIs via the resolver.
   *
   *  The reviewer's notes are ALSO auto-exposed as `$carry.feedback` with no
   *  manual wiring — so a re-dispatched node can address the rejection out of
   *  the box. An explicit `carry.feedback` entry on the loop overrides it. */
  private carryFor(nodeId: string, resolve: RefResolver): Record<string, string> {
    const carry: Record<string, string> = {};
    for (const n of this.workflow.nodes) {
      if (n.kind !== 'loop' || n.back_to !== nodeId) continue;
      // The owning review = the one whose reject names this loop (validation
      // guarantees exactly one).
      const owner = this.workflow.nodes.find((r) => isReview(r) && r.reject === n.id);
      const feedback = owner ? (this.state.rejectFeedback?.[owner.id] ?? '') : '';
      // Default: the reviewer's reject notes are available as `$carry.feedback`.
      // Seeded BEFORE the explicit-carry loop so an authored `feedback` wins.
      if (feedback && carry.feedback === undefined) carry.feedback = feedback;
      for (const [key, expr] of Object.entries(n.carry ?? {})) {
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
   * COMMIT PHASE — apply the decision, emit diary events, re-post escalated
   * gate on ceiling, persist intermediate state. Does NOT call advance().
   *
   * Split from onReviewDecision for Part 2 (build-plan step 7+8): `advance()`
   * can dispatch+await agents which may take minutes; by committing first and
   * running advance async, the HTTP caller receives a response in <100ms even
   * when a reject triggers an agent dispatch.
   *
   * `expectedInstanceToken` (optional): when supplied, passed to
   * applyReviewDecision's instance-token guard — a stale pre-ceiling decision
   * against the new escalated gate returns `{ rejected: 'instance-mismatch' }`.
   *
   * Returns `{ rejected }` if either guard fires (gate not open / token
   * mismatch), or `{ status }` with the committed run status otherwise.
   */
  async commitReviewDecision(
    reviewNodeId: string,
    decision: ReviewDecision,
    expectedInstanceToken?: string,
  ): Promise<{ rejected: ReviewRejected } | { rejected?: never; status: RunStatus }> {
    const outcome = applyReviewDecision(
      this.workflow,
      this.state,
      reviewNodeId,
      decision,
      undefined,
      expectedInstanceToken,
    );
    if (outcome.rejected) {
      return { rejected: outcome.rejected };
    }

    this.state = outcome.state;
    this.deps.event({
      type: decision.kind === 'approve' ? 'review_approved' : 'review_rejected',
      nodeId: reviewNodeId,
    });

    if (outcome.heldForHuman) {
      // FD-11 (M6 slice C) — the ceiling PAUSES, it never executes. The review
      // is back at awaiting-review; re-post it ESCALATED TO A HUMAN gate with
      // the loop context so the run waits (durably) instead of dying. The human
      // approves to continue past the gate, rejects to keep it held, or cancels
      // the run. ☠ the old holdForHuman no-op (the run used to just fail).
      this.deps.event({ type: 'iteration_ceiling_hit', nodeId: reviewNodeId });
      const reviewNode = this.byId.get(reviewNodeId);
      if (reviewNode && isReview(reviewNode)) {
        const loopId = reviewNode.reject;
        const count = loopId ? (this.state.rejectIterations?.[loopId] ?? 0) : 0;
        const resolve = this.deps.resolveRef(this.state);
        const bundle = this.resolveBundle(reviewNode, resolve);
        const escalated: WorkflowV2.ReviewNode = {
          ...reviewNode,
          reviewer: 'human',
          prompt:
            `⚠ LOOP CEILING REACHED — this gate rejected ${String(count)} time(s); the loop is exhausted. ` +
            `A human decision is required: APPROVE to accept the latest work and continue, ` +
            `REJECT to keep it held here, or cancel the run.\n\n` +
            (reviewNode.prompt ?? ''),
        };
        await this.deps.requestReview(escalated, this.ctx(resolve), bundle, {
          iteration: count,
          escalated: true,
        });
        this.deps.event({
          type: 'review_requested',
          nodeId: reviewNodeId,
          data: { bundle, escalated: true, iterations: count },
        });
      }
      // Ceiling: run stays paused; persist before responding.
      this.deps.persist(this.state, 'awaiting-review');
      return { status: 'awaiting-review' };
    }

    // Approve or kick-back: persist an intermediate `running` status. The async
    // advance that follows will persist the final settled status.
    const committedStatus = computeRunStatus(this.workflow, this.state);
    // ☠ FD-9 (M6 slice B): the approve-move / reject-move card effects are
    // gone — the card moves ONLY via explicit `move` steps on the forward path.
    this.deps.persist(this.state, committedStatus);
    return { status: committedStatus };
  }

  /**
   * Resolve a review decision (called by the server when the orchestrator/user
   * approves or rejects). Applies it to state, then advances (approve/kickback)
   * or holds for human (ceiling). Returns the new run status.
   *
   * For the HTTP/MCP path prefer calling commitReviewDecision + advance()
   * separately (build-plan step 8) so the response returns before dispatch.
   * This method remains for tests and any caller that needs the settled result.
   */
  async onReviewDecision(
    reviewNodeId: string,
    decision: ReviewDecision,
    expectedInstanceToken?: string,
  ): Promise<RunStatus> {
    const commit = await this.commitReviewDecision(reviewNodeId, decision, expectedInstanceToken);
    if (commit.rejected) {
      // Guard fired — gate is not open; return current computed status.
      return computeRunStatus(this.workflow, this.state);
    }
    if (commit.status === 'awaiting-review') {
      // Ceiling case: already persisted + re-posted; just advance to re-verify.
      return this.advance();
    }
    return this.advance();
  }

  private finalize(): RunStatus {
    // M6 slice C — a cancelled run finalizes CANCELLED: no workflow_failed
    // diary line, no failure notice (the cancel already wrote its own
    // workflow_cancelled line via the gateway).
    if (this.deps.isCancelled()) {
      this.deps.persist(this.state, 'cancelled' as RunStatus, { lastReason: 'cancelled' });
      return 'cancelled' as RunStatus;
    }
    const status = computeRunStatus(this.workflow, this.state);
    if (status === 'completed') this.deps.event({ type: 'workflow_completed' });
    else if (status === 'failed') this.deps.event({ type: 'workflow_failed' });
    this.persistRun(status);
    // Workflow-engine redesign — a failed run notifies the human inbox + the
    // project orchestrator (durable; survives an offline orchestrator). Fired
    // after persist so the run row is already terminal when the notice lands.
    if (status === 'failed') this.deps.notifyRunFailed?.(this.deriveFailureReason());
    // A successful completion nudges the orchestrator to run the workflow-doctor
    // (deduped to once-per-workflow at the mailbox layer). Fired after persist so
    // the run row is already terminal when the notice lands.
    if (status === 'completed') this.deps.notifyRunCompleted?.();
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
