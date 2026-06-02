// Section 19.4e — LIVE wiring for the v2 DAG executor. Implements DagExecutorDeps
// against the real machinery (work-item-as-contract creation, spawnSubagent,
// verification, worktree exec, channel posts, the v2 sidecar repo) and provides
// the fire entry point. Spawner / verification / exec / channel are injectable
// so the integration is testable against a real DB with a FAKE claude.exe (see
// test/dag-run-service.test.ts); the live claude.exe smoke is 19.14.

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExpectedOutput, Project, ULID, WorkflowV2 } from '@pc/domain';
import { substituteRefs, type RefResolver, type ReviewDecision, type RunStatus } from '@pc/workflows';
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
  type WorkflowReviewFlavor,
  type WorkflowReviewState,
} from '@pc/contracts';
import { createAgentWorkItem } from './agent-work-item.ts';
// Door-unification — workflow agent nodes dispatch through the SAME door the
// orchestrator uses (active-runs registration, canonical spawn, unified terminal
// + verification). The forked spawnSubagent path is gone.
import { dispatchFreshAgent } from './agent-run-factory.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';
import type { WorkItemService } from './work-item.ts';
import { announceWorkItemRow } from './work-item-writer.ts';
import type { WorktreeService } from './worktree.ts';

const execFileAsync = promisify(execFile);

export type CommandExec = (
  kind: 'bash' | 'node' | 'python',
  code: string,
  opts: { cwd: string; timeout?: number }
) => Promise<{ ok: boolean; error?: string; stdout?: string }>;

/** Per-node stdout cap stored in the DAG state. Plenty for typical
 *  `echo`/`git status`/`jq` outputs; trims giant logs that would otherwise
 *  bloat the workflow_runs_v2.dagState JSON column. */
const STDOUT_CAP_BYTES = 16 * 1024;

function truncateStdout(s: string): string {
  if (s.length <= STDOUT_CAP_BYTES) return s;
  return s.slice(0, STDOUT_CAP_BYTES) + `\n…[truncated, ${String(s.length - STDOUT_CAP_BYTES)} more bytes]`;
}

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
  channelPort: number;
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
  exec?: CommandExec;
  /** Mailbox review delivery seam — the review prompt is enqueued as a mailbox
   *  message. Injected from index.ts. */
  deliverReview?: WorkflowReviewDelivery;
  /** Mailbox failed-run delivery seam — a failed run notifies the human inbox +
   *  the project orchestrator. Injected from index.ts. */
  deliverRunFailed?: WorkflowRunFailedDelivery;
}

const liveExec: CommandExec = async (kind, code, { cwd, timeout }) => {
  const [cmd, args]: [string, string[]] =
    kind === 'bash' ? ['bash', ['-c', code]] : kind === 'node' ? ['node', ['-e', code]] : ['python', ['-c', code]];
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      timeout,
      killSignal: 'SIGKILL', // hard-kill on timeout (PC improvement over Archon's soft abort)
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { ok: true, stdout: truncateStdout(String(stdout).replace(/\r?\n$/, '')) };
  } catch (err) {
    const e = err as Error & { killed?: boolean };
    const reason = e.killed && timeout !== undefined ? `timeout (${String(timeout)}ms exceeded)` : e.message;
    return { ok: false, error: reason };
  }
};

/** awaiting-review maps to the persisted `paused` status. */
function toRunStatus(s: RunStatus): WorkflowV2.WorkflowRunStatus {
  return s === 'awaiting-review' ? 'paused' : (s as WorkflowV2.WorkflowRunStatus);
}

/** Apply `$carry.X` substitution on top of `$nodeId.output` resolution. */
function render(template: string, ctx: DagNodeContext, escapedForBash = false): string {
  const withRefs = substituteRefs(template, ctx.resolve, { escapedForBash });
  return withRefs.replace(/\$carry\.([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, key: string) => ctx.carry[key] ?? '');
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
  const exec = opts.exec ?? liveExec;

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
      // Bash/script nodes have no work item — they expose captured stdout via
      // `rec.output` (F#1). Field-form refs on a bash node have nothing to read
      // beyond bare output, so they resolve to empty.
      if (rec?.workItemId === undefined && rec?.output !== undefined) {
        return field ? '' : rec.output;
      }
      const wiId = rec?.workItemId;
      if (!wiId) return '';
      const wi = getWorkItem(wiId as ULID);
      if (!wi) return '';
      if (!field) return wi.body ?? '';
      const v = wi.fields?.[field];
      if (v == null) return '';
      return typeof v === 'string' ? v : JSON.stringify(v);
    };

  const dispatchAgent = async (
    node: WorkflowV2.AgentNode,
    ctx: DagNodeContext
  ): Promise<NodeOutcome> => {
    const task = render(node.task, ctx);

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
        contractService: new ContractService(),
        getPodRowExpectedOutput: (podName) => {
          const row = resolveAgentForDispatch(podName, opts.projectId);
          return row?.expectedOutput as ExpectedOutput | null | undefined;
        },
      }
    );

    const childContract =
      new ContractService().listByWorkItem(childWi.id as ULID).slice(-1)[0] ?? null;
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

  const runCommand = async (
    node: WorkflowV2.BashNode | WorkflowV2.ScriptNode,
    ctx: DagNodeContext
  ): Promise<NodeOutcome> => {
    const cwd = run.worktreePath ?? opts.workspaceDir;
    const kind: 'bash' | 'node' | 'python' = node.kind === 'bash' ? 'bash' : node.runtime;
    const code = node.kind === 'bash' ? render(node.bash, ctx, true) : render(node.script, ctx);
    const r = await exec(kind, code, { cwd, ...(node.timeout !== undefined ? { timeout: node.timeout } : {}) });
    if (!r.ok) return { state: 'failed', ...(r.error ? { error: r.error } : {}) };
    return { state: 'completed', ...(r.stdout !== undefined ? { output: r.stdout } : {}) };
  };

  const moveWorkItem = async (
    node: WorkflowV2.MoveWorkItemNode,
    _ctx: DagNodeContext
  ): Promise<NodeOutcome> => {
    if (!run.workItemId) {
      return { state: 'failed', error: 'move-work-item: run has no root work item' };
    }
    const project = opts.getProject();
    const stages = project.stages ?? [];
    const targetStage = stages.find((s) => s.id === node.to_stage);
    if (!targetStage) {
      return {
        state: 'failed',
        error: `move-work-item node "${node.id}": stage "${node.to_stage}" not found in project`,
      };
    }
    const wi = getWorkItem(run.workItemId);
    if (!wi) {
      return { state: 'failed', error: `move-work-item: run root work item ${run.workItemId} not found` };
    }
    const moved = moveWorkItemStage(run.workItemId, node.to_stage);
    if (moved) {
      // Slice 015b — announce through the durable door (outbox row); the relay
      // delivers the canonical work-item.changed frame. No hand-fanout.
      announceWorkItemRow(moved, opts.projectId, 'moved');
    }
    return { state: 'completed', output: node.to_stage };
  };

  const requestReview = async (
    node: WorkflowV2.HumanReviewNode | WorkflowV2.OrchestratorReviewNode,
    _ctx: DagNodeContext,
    bundle: { nodeId: string; output: string }[]
  ): Promise<void> => {
    const flavor = node.kind === 'orchestrator-review' ? 'orchestrator' : 'human';
    const summary = bundle.map((b) => `### ${b.nodeId}\n${b.output}`).join('\n\n');
    const body =
      `[pc:workflow-review run=${run.id} node=${node.id} flavor=${flavor}]\n` +
      `${node.prompt ?? 'Please review the work below.'}\n\n${summary}\n\n` +
      `Approve: pc_complete_node-equivalent (v2 review endpoint) · Reject sends it back.`;
    if (node.kind === 'orchestrator-review') {
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
    runCommand,
    moveWorkItem,
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
    reviewNode?.kind === 'orchestrator-review' ? 'orchestrator' : 'human';
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
