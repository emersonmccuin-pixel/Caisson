// Section 19.4e — LIVE wiring for the v2 DAG executor. Implements DagExecutorDeps
// against the real machinery (work-item-as-contract creation, the agent-dispatch
// door, verification, worktree exec, channel posts, the v2 sidecar repo) and provides
// the fire entry point. Spawner / verification / exec / channel are injectable
// so the integration is testable against a real DB with a FAKE claude.exe (see
// test/dag-run-service.test.ts); the live claude.exe smoke is 19.14.

import { randomUUID } from 'node:crypto';
import type { ExpectedOutput, Project, ULID, WorkflowV2 } from '@pc/domain';
import {
  substituteRefs,
  substituteInputs,
  type RefResolver,
  type ReviewDecision,
  type RunStatus,
} from '@pc/workflows';
import {
  getWorkItem,
  moveWorkItemStage,
  resolveAgentForDispatch,
  workflowRunsV2Repo,
} from '@pc/db';
import { DagExecutor, type DagExecutorDeps, type DagNodeContext, type NodeOutcome } from './dag-executor.ts';
import { announceRunCreated, writeDagAndStatus } from './workflow-run-writer.ts';
import { ContractService, WorkflowRunMutationGateway } from '@pc/app-services';
import {
  contractDeliverableText,
  type WorkflowReviewFlavor,
  type WorkflowReviewState,
} from '@pc/contracts';
import { createAgentWorkItem } from './agent-work-item.ts';
// Door-unification — workflow agent nodes dispatch through the SAME door the
// orchestrator uses (active-runs registration, canonical spawn, unified terminal
// + verification). The forked subagent-spawn path is gone.
import { dispatchFreshAgent } from './agent-run-factory.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';
import type { WorkItemService } from './work-item.ts';
import { announceWorkItemRow } from './work-item-writer.ts';
import type { WorktreeService } from './worktree.ts';

/** Workflow-review delivery seam. The DAG executor calls this to enqueue a
 *  durable `workflow-review` mailbox message (active-orchestrator +
 *  orchestrator-turn). Injected from index.ts where the mailboxService lives —
 *  ProjectRuntime never gains a mailbox ref. The slice-004
 *  workflow.review.changed fact fires regardless (it is state, not delivery). */
export type WorkflowReviewDelivery = (input: {
  projectId: ULID;
  runId: ULID;
  nodeId: string;
  flavor: WorkflowReviewFlavor;
  body: string;
}) => boolean;

/** Workflow-engine redesign — failed-run notification seam. Enqueues a durable
 *  `workflow-run-failed` mailbox message to BOTH the human user-inbox AND the
 *  project orchestrator (active-orchestrator). When no orchestrator is live the
 *  delivery persists and drains on its next liveness pass. Injected from
 *  index.ts where the mailboxService lives. */
export type WorkflowRunFailedDelivery = (input: {
  projectId: ULID;
  runId: ULID;
  workflowName: string;
  workItemId: ULID | null;
  reason: string;
}) => void;

// Slice 015b — durable workflow.review.changed facts via the run gateway. The
// gateway writes the in-txn `live_outbox` row; the 015a relay drains + delivers
// it. The run-row state still flows through workflow-run-writer; this is the
// review audit/action surface. The old hand-fanned canonical frame + legacy
// `workflow-v2-review-pending` envelope are deleted — delivery is door-only.
const reviewGateway = new WorkflowRunMutationGateway();

function emitReviewFact(
  opts: { projectId: ULID },
  input: {
    runId: ULID;
    nodeId: string;
    flavor: WorkflowReviewFlavor;
    state: WorkflowReviewState;
    prompt?: string | null;
    notes?: string;
  },
): void {
  reviewGateway.commitReviewChange({
    projectId: opts.projectId,
    runId: input.runId,
    nodeId: input.nodeId,
    flavor: input.flavor,
    state: input.state,
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
}

export interface DagRunServiceOptions {
  projectId: ULID;
  workspaceDir: string;
  serverPort?: number;
  dataDir?: string;
  templatesDir?: string;
  trunkPath?: string;
  getProject: () => Project;
  workItemService: WorkItemService;
  worktrees: WorktreeService;
  /** Per-dispatch session-data dir factory. */
  sessionDirFor: (pcSessionId: string) => string;
  broadcast: (event: unknown) => void;
  hostClient?: AgentHostReattachClient | null;
  // ── injectable seams (live defaults) ──
  /** Mailbox review delivery seam — the review prompt is enqueued as a mailbox
   *  message. Injected from index.ts. */
  deliverReview?: WorkflowReviewDelivery;
  /** Mailbox failed-run delivery seam — a failed run notifies the human inbox +
   *  the project orchestrator. Injected from index.ts. */
  deliverRunFailed?: WorkflowRunFailedDelivery;
}

/** awaiting-review maps to the persisted `paused` status. */
function toRunStatus(s: RunStatus): WorkflowV2.WorkflowRunStatus {
  return s === 'awaiting-review' ? 'paused' : (s as WorkflowV2.WorkflowRunStatus);
}

/** Apply `$carry.X` substitution on top of `$nodeId.output` resolution. */
function render(template: string, ctx: DagNodeContext, escapedForBash = false): string {
  const withRefs = substituteRefs(template, ctx.resolve, { escapedForBash });
  return withRefs.replace(/\$carry\.([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, key: string) => ctx.carry[key] ?? '');
}

/** Render a node body (task / prompt) with its DECLARED input ports wired in:
 *  resolve each `input:` value (a `$ref`/literal → the upstream deliverable),
 *  then substitute the node's `{{name}}` placeholders. The body's own inline
 *  `$node.output` / `$carry.*` refs are still rendered (back-compat), but the
 *  input map is the declared, save-validated wiring — the "specific place an
 *  output feeds the next node's input". */
function renderBody(
  template: string,
  input: Record<string, string> | undefined,
  ctx: DagNodeContext,
): string {
  const resolvedInputs: Record<string, string> = {};
  for (const [name, expr] of Object.entries(input ?? {})) {
    resolvedInputs[name] = render(expr, ctx);
  }
  return substituteInputs(render(template, ctx), resolvedInputs);
}

interface RunHandle {
  id: ULID;
  workItemId: ULID | null;
  worktreePath: string | null;
}

/** Build the live DagExecutorDeps for one run. */
export function makeExecutorDeps(
  run: RunHandle,
  workflow: WorkflowV2.Workflow,
  opts: DagRunServiceOptions
): DagExecutorDeps {
  // One ContractService for the whole run's deps — the deliverable resolver
  // (below) + the child-contract reads in dispatchAgent share it.
  const contractService = new ContractService();

  const resolveRef =
    (state: WorkflowV2.WorkflowDagState): RefResolver =>
    (nodeId, field) => {
      // Reserved synthetic ref: $root.output → run-root card body;
      // $root.output.<field> → run-root card fields[field].
      if (nodeId === 'root') {
        const rootWi = run.workItemId ? getWorkItem(run.workItemId) : null;
        if (!rootWi) return '';
        if (!field) return rootWi.body ?? '';
        const v = rootWi.fields?.[field];
        if (v == null) return '';
        return typeof v === 'string' ? v : JSON.stringify(v);
      }
      const rec = state.nodes[nodeId];
      // Legacy captured-stdout nodes (no work item) expose bare output. Field-
      // form refs on one have nothing structured to read, so resolve to empty.
      if (rec?.workItemId === undefined && rec?.output !== undefined) {
        return field ? '' : rec.output;
      }
      const wiId = rec?.workItemId;
      if (!wiId) return '';

      // `$nodeId.output` = the agent's PRODUCED DELIVERABLE — the ONE output
      // port — submitted via pc_submit_deliverable and stored on the linked
      // contract. It is NOT the child WI body (that holds the TASK the agent was
      // given). There is deliberately NO fallback to the body: a step that
      // produced no deliverable fails the completion gate (→ its run fails → the
      // downstream consumer is skipped), so a missing deliverable can never leak
      // the task text into a downstream input.
      const contract = contractService.listByWorkItem(wiId as ULID).slice(-1)[0] ?? null;
      if (!field) {
        return contract ? contractDeliverableText(contract.deliverable, contract.report) : '';
      }
      // Field form: a structured `payload` deliverable's data field wins; else
      // the child WI's stored field (legacy).
      if (contract?.deliverable?.kind === 'payload') {
        const data = contract.deliverable.data;
        if (data && typeof data === 'object' && field in (data as Record<string, unknown>)) {
          const fv = (data as Record<string, unknown>)[field];
          return fv == null ? '' : typeof fv === 'string' ? fv : JSON.stringify(fv);
        }
      }
      const wi = getWorkItem(wiId as ULID);
      const v = wi?.fields?.[field];
      if (v == null) return '';
      return typeof v === 'string' ? v : JSON.stringify(v);
    };

  const dispatchAgent = async (
    node: WorkflowV2.AgentNode,
    ctx: DagNodeContext
  ): Promise<NodeOutcome> => {
    const task = renderBody(node.task, node.input, ctx);

    // Project-scope enforcement: workflow nodes must use project-scoped pods.
    // Global pods must first be cloned into the project (POST
    // /api/agents/pods/:id/clone-to-project). The door (dispatchFreshAgent)
    // would silently fall back to a global pod, so gate it here.
    const podRow = resolveAgentForDispatch(node.agent, opts.projectId);
    if (!podRow) {
      return { state: 'failed', error: `pod "${node.agent}" not found in registry` };
    }
    if (podRow.scope === 'global') {
      return {
        state: 'failed',
        error: `pod "${node.agent}" is global-scope — clone it into project ${opts.projectId} before using it in a workflow node`,
      };
    }

    // Contract birth — the one thing the workflow still OWNS: mint the child
    // work item + its linked contract (the verification spine). Everything after
    // (spawn, lifecycle, completion, verify, bookkeeping) is the door's job now.
    const childWi = createAgentWorkItem(
      {
        title: `${workflow.name} · ${node.id}`,
        task,
        pod: node.agent,
        ...(node.expected_output ? { expectedOutput: node.expected_output } : {}),
        // Workflow-level review is done via review NODES, so agent-node child
        // WIs always verify on the `auto` tier (no per-node double-gating).
        verificationTier: 'auto',
        parentWorkItemId: run.workItemId,
        worktree: run.worktreePath,
      },
      {
        workItemService: opts.workItemService,
        getProject: opts.getProject,
        // Mint the linked contract here so the door resolves + reuses it (no
        // double contract). The door requires an expectedOutput for a WI-linked
        // dispatch; we read it back off this contract below.
        contractService,
        getPodRowExpectedOutput: (podName) => {
          const row = resolveAgentForDispatch(podName, opts.projectId);
          return row?.expectedOutput as ExpectedOutput | null | undefined;
        },
      }
    );

    const childContract =
      contractService.listByWorkItem(childWi.id as ULID).slice(-1)[0] ?? null;
    if (!childContract) {
      return {
        state: 'failed',
        workItemId: childWi.id as ULID,
        error: `contract was not minted for node "${node.id}"`,
      };
    }

    const worktreeDir = run.worktreePath ?? opts.workspaceDir;
    const pcSessionId = `wf-${run.id.slice(-8)}-${node.id}-${randomUUID().slice(0, 8)}`;

    // Keep initialInput SHORT + single-line (long/multi-line breaks the spawn
    // echo-ack handshake). Worktree isolation is enforced by path-guard.cjs via
    // the PC_WORKFLOW_* env vars (passed as extraEnv below), NOT by this string.
    const initialInput =
      `You have a contract for this node. A work item (${childWi.id}) is linked as your source — call pc_get_work_item({ id: "${childWi.id}" }) to read its body for context, then begin. Your expected output + acceptance criteria are on the contract (shown in your prompt). Work only inside your worktree — all file edits and git commands must run here. When finished, submit your deliverable with pc_submit_deliverable as your final action.`;

    // Dispatch through the ONE door. It materialises the pod, inserts +
    // REGISTERS the run in active-runs (→ reconciler matches it → no host-lost),
    // spawns canonically, detects completion via the unified terminal path, and
    // runs verification on the contract. `done` resolves at the verified
    // terminal. PC_WORKFLOW_* keep path-guard worktree confinement; node.timeout
    // maps to the idle-timeout override.
    const result = await dispatchFreshAgent(
      {
        projectId: opts.projectId,
        worktreeDir,
        agentName: node.agent,
        input: initialInput,
        dispatcherSessionId: pcSessionId,
        parentWorkItemId: run.workItemId,
        workItemId: childWi.id as ULID,
        expectedOutput: childContract.expectedOutput,
        invokeDepth: 0,
        slug: opts.getProject().slug,
        extraEnv: {
          PC_WORKFLOW_RUN_ID: run.id,
          PC_WORKFLOW_WORKTREE: worktreeDir,
        },
        ...(node.timeout !== undefined ? { idleMs: node.timeout } : {}),
      },
      {
        broadcast: opts.broadcast,
        ...(opts.hostClient ? { hostClient: opts.hostClient } : {}),
      }
    );

    // Pre-spawn failure (unknown pod, scratch mkdir, host unavailable, …). No
    // run ever started; surface it as a failed node.
    if (!result.ok) {
      return { state: 'failed', workItemId: childWi.id as ULID, error: result.error };
    }

    // Await the verified terminal. A node fails when the run didn't complete OR
    // verification failed (drives reject/loop edges). `pending` (tier-2/3 hold)
    // is NOT a failure — it leaves the node completed.
    const outcome = await result.done;
    const failed =
      outcome.status !== 'completed' || outcome.verification?.status === 'failed';
    const error =
      outcome.failureReason ?? outcome.verification?.notes ?? `node "${node.id}" failed`;

    return {
      state: failed ? 'failed' : 'completed',
      workItemId: childWi.id as ULID,
      ...(failed ? { error } : {}),
    };
  };

  // Card-move TRANSITION EFFECT (locked decision 1) — move the run-root card to
  // `stage` WITHOUT firing that stage's on-entry workflows (loop-safe). Replaces
  // the old move-work-item node. Best-effort: returns ok/error so the executor
  // can log a failed move without failing the (already-completed) step.
  const moveCard = async (stage: string): Promise<{ ok: boolean; error?: string }> => {
    if (!run.workItemId) return { ok: false, error: 'run has no root work item' };
    const stages = opts.getProject().stages ?? [];
    if (!stages.some((s) => s.id === stage)) {
      return { ok: false, error: `stage "${stage}" not found in project` };
    }
    if (!getWorkItem(run.workItemId)) {
      return { ok: false, error: `run root work item ${run.workItemId} not found` };
    }
    const moved = moveWorkItemStage(run.workItemId, stage);
    if (moved) {
      // Slice 015b — announce through the durable door (outbox row); the relay
      // delivers the canonical work-item.changed frame. No hand-fanout.
      announceWorkItemRow(moved, opts.projectId, 'moved');
    }
    return { ok: true };
  };

  const requestReview = async (
    node: WorkflowV2.ReviewNode,
    ctx: DagNodeContext,
    bundle: { nodeId: string; output: string }[]
  ): Promise<void> => {
    const flavor = node.reviewer;
    const summary = bundle.map((b) => `### ${b.nodeId}\n${b.output}`).join('\n\n');
    const prompt = node.prompt ? renderBody(node.prompt, node.input, ctx) : 'Please review the work below.';
    const body =
      `[pc:workflow-review run=${run.id} node=${node.id} flavor=${flavor}]\n` +
      `${prompt}\n\n${summary}\n\n` +
      `Approve: pc_complete_node-equivalent (v2 review endpoint) · Reject sends it back.`;
    if (node.reviewer === 'orchestrator') {
      // 017 Phase C — the review prompt is enqueued as a durable mailbox message
      // (active-orchestrator + orchestrator-turn) via the wired seam. No Channel.
      opts.deliverReview?.({
        projectId: opts.projectId,
        runId: run.id,
        nodeId: node.id,
        flavor,
        body,
      });
    }
    // Slice 015b — durable workflow.review.changed (pending) fact via the
    // gateway's in-txn live_outbox row. The 015a relay drains + delivers it;
    // the web `scanWorkflowLiveEvents` consumer reads the canonical frame. The
    // old hand-fanned frame + legacy `workflow-v2-review-pending` envelope are
    // deleted — delivery flows through the door only.
    reviewGateway.commitReviewChange({
      projectId: opts.projectId,
      runId: run.id,
      nodeId: node.id,
      flavor,
      state: 'pending',
      prompt: node.prompt ?? null,
    });
  };

  const persist = (
    state: WorkflowV2.WorkflowDagState,
    status: RunStatus,
    o?: { lastReason?: string }
  ): void => {
    // Write-door: both DB writes go through the writer which reads back the
    // full row (including updated `rev`) before broadcasting the snapshot.
    writeDagAndStatus(
      run.id,
      state,
      toRunStatus(status),
      { ...(o?.lastReason !== undefined ? { lastReason: o.lastReason } : {}) },
      opts.projectId,
      opts.broadcast,
    );
  };

  return {
    resolveRef,
    dispatchAgent,
    moveCard,
    requestReview,
    persist,
    event: (ev) => {
      workflowRunsV2Repo.appendEvent({
        runId: run.id,
        type: ev.type,
        ...(ev.nodeId ? { nodeId: ev.nodeId } : {}),
        ...(ev.data ? { data: ev.data } : {}),
      });
    },
    isCancelled: () => workflowRunsV2Repo.getRun(run.id)?.status === 'cancelled',
    notifyRunFailed: (reason) =>
      opts.deliverRunFailed?.({
        projectId: opts.projectId,
        runId: run.id,
        workflowName: workflow.name,
        workItemId: run.workItemId ?? null,
        reason,
      }),
    holdForHuman: (_nodeId, _reason) => {
      // Slice 015c — the legacy `workflow-v2-human-hold` envelope is deleted: it
      // had no web consumer, and the durable fact (the run advancing to `failed`
      // on the iteration-ceiling path) already rides the relay's
      // `workflow.run.changed` frame, with the `iteration_ceiling_hit` event
      // appended to the run log for audit. Nothing else to deliver.
    },
  };
}

export interface FireResult {
  runId: ULID;
  rootWorkItemId: ULID;
  /** Resolves when the run pauses (review), completes, or fails. */
  done: Promise<RunStatus>;
}

/**
 * Fire a v2 workflow.
 *
 * When `triggerWorkItemId` is supplied (stage-on-entry path): the existing card
 * becomes the run root — no new work item is minted, its stage is unchanged, and
 * `isWorkflowRoot` is not set on it. Child-node `parentWorkItemId` and the
 * worktree acquire still hang off that card.
 *
 * When absent (manual fire / HTTP route): a blank root work item is created in
 * stage[0] with `isWorkflowRoot: true`, preserving the previous behaviour.
 *
 * `done` resolves at the first pause/terminal; callers that don't want to block
 * (HTTP route) ignore it.
 */
export async function fireDagWorkflow(
  workflow: WorkflowV2.Workflow,
  trigger: WorkflowV2.WorkflowTrigger,
  opts: DagRunServiceOptions,
  triggerWorkItemId?: ULID,
): Promise<FireResult> {
  let rootWiId: ULID;

  if (triggerWorkItemId) {
    const existing = getWorkItem(triggerWorkItemId);
    if (!existing) throw new Error(`trigger work item not found: ${triggerWorkItemId}`);
    rootWiId = triggerWorkItemId;
  } else {
    const project = opts.getProject();
    const stages = (project.stages ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const stageId = stages[0]?.id;
    if (!stageId) throw new Error('project has no stages — cannot create a workflow run root');
    const rootWi = opts.workItemService.create({
      title: workflow.name,
      stageId,
      body: `Workflow run — ${workflow.name}`,
      isWorkflowRoot: true,
    });
    rootWiId = rootWi.id as ULID;
  }

  let worktreePath: string | null = null;
  if (workflow.worktree !== 'none') {
    const wt = await opts.worktrees.ensureWorktree(`wf-${rootWiId.slice(-8)}`);
    worktreePath = wt.path;
  }

  const run = workflowRunsV2Repo.createRun({
    workflowId: workflow.id,
    workflowName: workflow.name,
    projectId: opts.projectId,
    workflowYamlSnapshot: JSON.stringify(workflow),
    trigger: trigger.kind,
    ...(trigger.kind === 'stage-on-entry' ? { stageId: trigger.stage } : {}),
    workItemId: rootWiId,
    worktreePath,
    status: 'running',
  });
  workflowRunsV2Repo.markStarted(run.id);
  // Announce creation so the right rail shows the new run immediately.
  // Re-read after markStarted so the snapshot carries the started rev.
  const startedRow = workflowRunsV2Repo.getRun(run.id);
  if (startedRow) announceRunCreated(startedRow, opts.projectId, opts.broadcast);

  const deps = makeExecutorDeps(
    { id: run.id, workItemId: rootWiId, worktreePath },
    workflow,
    opts
  );
  const exec = DagExecutor.start(workflow, deps, {
    runId: run.id,
    rootWorkItemId: rootWiId,
    worktreePath,
  });

  return { runId: run.id, rootWorkItemId: rootWiId, done: exec.advance() };
}

/**
 * Resume a paused run to apply a review decision. Loads the run + its frozen
 * workflow + DAG state, then drives the executor's onReviewDecision.
 */
export async function applyV2ReviewDecision(
  runId: ULID,
  reviewNodeId: string,
  decision: ReviewDecision,
  opts: DagRunServiceOptions
): Promise<RunStatus | null> {
  const run = workflowRunsV2Repo.getRun(runId);
  if (!run) return null;
  const workflow = JSON.parse(run.workflowYamlSnapshot) as WorkflowV2.Workflow;
  const deps = makeExecutorDeps(
    { id: run.id, workItemId: run.workItemId, worktreePath: run.worktreePath },
    workflow,
    opts
  );
  const exec = DagExecutor.resume(workflow, run.dagState, deps, {
    runId: run.id,
    rootWorkItemId: run.workItemId,
    worktreePath: run.worktreePath,
  });
  const result = await exec.onReviewDecision(reviewNodeId, decision);
  // Slice 004 — durable workflow.review.changed (approved/rejected) fact +
  // canonical frame. The run-state transition itself already fanned out a
  // workflow.run.changed via the writer during resume.
  const reviewNode = workflow.nodes.find((n) => n.id === reviewNodeId);
  const flavor: WorkflowReviewFlavor =
    reviewNode && reviewNode.kind === 'review' ? reviewNode.reviewer : 'human';
  emitReviewFact(opts, {
    runId: run.id,
    nodeId: reviewNodeId,
    flavor,
    state: decision.kind === 'approve' ? 'approved' : 'rejected',
    ...(decision.kind === 'reject' && decision.notes !== undefined
      ? { notes: decision.notes }
      : {}),
  });
  return result;
}
