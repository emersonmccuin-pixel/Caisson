// Section 19.4e — LIVE wiring for the v2 DAG executor. Implements DagExecutorDeps
// against the real machinery (work-item-as-contract creation, the agent-dispatch
// door, verification, worktree exec, channel posts, the v2 sidecar repo) and provides
// the fire entry point. Spawner / verification / exec / channel are injectable
// so the integration is testable against a real DB with a FAKE claude.exe (see
// test/dag-run-service.test.ts); the live claude.exe smoke is 19.14.

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { ExpectedOutput, PodMcpServerConfig, Project, ULID, WorkflowV2 } from '@pc/domain';
import {
  substituteRefs,
  substituteInputs,
  resumeCompatErrors,
  resetFailedNodesForResume,
  type RefResolver,
  type ReviewDecision,
  type ReviewRejected,
  type RunStatus,
} from '@pc/workflows';
import {
  getWorkItem,
  listMcpServersRegistry,
  moveWorkItemStage,
  newId,
  resolveAgentForDispatch,
  workflowRunsV2Repo,
} from '@pc/db';
import { callMcpTool, type CallToolOutcome } from '@pc/mcp/call';
import { DagExecutor, type DagExecutorDeps, type DagNodeContext, type NodeOutcome } from './dag-executor.ts';
import { announceRunCreated, writeDagAndStatus } from './workflow-run-writer.ts';
import {
  ContractService,
  WorkItemMutationGateway,
  WorkflowRunMutationGateway,
} from '@pc/app-services';
import {
  buildDecisionContract,
  classifyInboxItem,
  contractDeliverableText,
  decisionContractHeaderText,
  makeReviewPackage,
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
import type { WorktreeService } from './worktree.ts';

/** FD-12 — the one write door (repo write + outbox receipt in one txn). */
const workItemGateway = new WorkItemMutationGateway();

// ── Per-run serialization lock (build-plan step 4 / R2) ─────────────────────
// Two near-simultaneous review decisions for the same run can both read
// `awaiting-review` before either persists, causing two advances and two
// concurrent agents in the same worktree. A per-runId in-process mutex closes
// the TOCTOU window. Single-server process model only (R2 — not multi-process
// safe; acceptable for the current architecture).
const _runLocks = new Map<string, Promise<void>>();

function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _runLocks.get(runId) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  _runLocks.set(runId, next);
  // Chain the work after any previous locked operation; always release.
  return prev.then(fn).finally(() => {
    resolve();
    // GC: remove the entry once the chain is empty (no more waiters).
    if (_runLocks.get(runId) === next) _runLocks.delete(runId);
  });
}

/** Workflow-review delivery seam. The DAG executor calls this to enqueue a
 *  durable `workflow-review` mailbox message — orchestrator flavor →
 *  active-orchestrator (orchestrator-turn); human flavor (incl. M6-C ceiling
 *  escalation) → the human user-inbox (M8/FD-7: a human gate is never
 *  invisible). Injected from index.ts where the mailboxService lives —
 *  ProjectRuntime never gains a mailbox ref. The slice-004
 *  workflow.review.changed fact fires regardless (it is state, not delivery). */
export type WorkflowReviewDelivery = (input: {
  projectId: ULID;
  runId: ULID;
  nodeId: string;
  flavor: WorkflowReviewFlavor;
  body: string;
  subject: string;
  /** Review package for the inbox decision card (slice C renders it). */
  payload: Record<string, unknown>;
  /** Iteration-keyed so a loop kick-back's re-review delivers AGAIN (FD-8). */
  idempotencyKey: string;
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
  /** S5/FD-14 — 0-based failure incident: the count of `run_resumed` diary
   *  lines at failure time. Keys the mailbox idempotency so a run that fails,
   *  gets resumed, and fails AGAIN mints a FRESH card (FD-8 — the constant
   *  per-run key silently dropped the second failure). Same incident
   *  re-delivered (crash replay) still dedupes. */
  incident: number;
}) => void;

/** Completed-run notification seam — a run finalizing `completed` nudges the
 *  project orchestrator to run the workflow-doctor. The delivery
 *  (deliverWorkflowFirstRunReview in index.ts) keys its mailbox message
 *  `workflow-first-run-review:<workflowId>`, so the nudge fires exactly once per
 *  workflow (on its first completion). Injected from index.ts. */
export type WorkflowRunCompletedDelivery = (input: {
  projectId: ULID;
  runId: ULID;
  workflowId: string;
  workflowName: string;
  workItemId: ULID | null;
}) => void;

// Slice 015b — durable workflow.review.changed facts via the run gateway. The
// gateway writes the in-txn `live_outbox` row; the 015a relay drains + delivers
// it. The run-row state still flows through workflow-run-writer; this is the
// review audit/action surface. The old hand-fanned canonical frame + legacy
// `workflow-v2-review-pending` envelope are deleted — delivery is door-only.
// M3a — the same gateway is now also THE diary door (appendRunEvent): every
// run-diary line below pairs its event row with a `workflow.run.event` fact.
const runGateway = new WorkflowRunMutationGateway();

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
  runGateway.commitReviewChange({
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
  /** Completed-run notification seam — nudges the orchestrator to run the
   *  workflow-doctor (once per workflow, deduped at the mailbox). Injected from
   *  index.ts; absent ⟹ no nudge. */
  deliverRunCompleted?: WorkflowRunCompletedDelivery;
  /** M8 (FD-7) — decided-elsewhere inbox resolution seam (MailboxService
   *  collect/action pair). A review decided through ANY door (inbox card,
   *  orchestrator pc_complete_node, raw HTTP) actions the open inbox cards for
   *  that gate, so they never linger. Snapshot-before-decide: a card the
   *  decision itself mints (ceiling escalation, same source) stays open. */
  reviewInbox?: ReviewInboxResolution;
  /** `call` node MCP invocation seam — live default is callMcpTool (@pc/mcp).
   *  Injectable so dag-run tests exercise call nodes without a real server. */
  mcpToolCaller?: (
    config: PodMcpServerConfig,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<CallToolOutcome>;
}

/** M8 (FD-7) — the MailboxService collect/action pair, structural so runtime
 *  layers thread it without an app-services value import. */
export interface ReviewInboxResolution {
  collectUnactionedRecipients(sourceKind: string, sourceId: string): ULID[];
  actionRecipients(ids: readonly ULID[], now: number): number;
}

/** awaiting-review maps to the persisted `paused` status. */
function toRunStatus(s: RunStatus): WorkflowV2.WorkflowRunStatus {
  return s === 'awaiting-review' ? 'paused' : (s as WorkflowV2.WorkflowRunStatus);
}

/** Cap on a `call` node's captured output stored in dag_state. */
const CALL_OUTPUT_MAX_CHARS = 32_000;

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
      // Captured-output nodes (no work item — `call` steps): bare refs read the
      // output whole; field-form refs read a key off a JSON-object output (a
      // structured tool result), resolving to '' when the output isn't one.
      if (rec?.workItemId === undefined && rec?.output !== undefined) {
        if (!field) return rec.output;
        try {
          const parsed: unknown = JSON.parse(rec.output);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const fv = (parsed as Record<string, unknown>)[field];
            if (fv == null) return '';
            return typeof fv === 'string' ? fv : JSON.stringify(fv);
          }
        } catch {
          // not JSON — fall through to empty
        }
        return '';
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

    // Membership-visibility check: any pod visible to the project (stock ∪
    // members) is valid in a workflow node. resolveAgentForDispatch already
    // enforces this via listProjectVisibleAgents — if it returns a row the pod
    // is dispatchable here, regardless of its scope column.
    const podRow = resolveAgentForDispatch(node.agent, opts.projectId);
    if (!podRow) {
      return { state: 'failed', error: `pod "${node.agent}" not found in this project's agent roster` };
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
    // maps to the wall-clock ceiling (P9/FD-17 — idle-kill is deleted; a step
    // timeout means "may not run longer than X").
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
        ...(node.timeout !== undefined ? { wallClockMs: node.timeout } : {}),
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

    // M3a — the diary's debugging cross-link (FD-11): which agent run + child
    // work item this node dispatched. "Step write is stuck" → the diary hands
    // you the runId to inspect.
    runGateway.appendRunEvent({
      projectId: opts.projectId,
      runId: run.id,
      type: 'agent_dispatched',
      nodeId: node.id,
      data: { agentRunId: result.agentRunId, workItemId: childWi.id, agent: node.agent },
    });

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

  // `call` node — engine-executed MCP tool call (no agent in the loop).
  // Resolve the registered server (project scope shadows global), render the
  // args with the same substitution agent tasks get, invoke through the typed
  // client, and capture the result as the node's output (feeds downstream
  // `$nodeId.output[.field]` refs). Every failure mode — unknown server, tool
  // error, transport failure, timeout — settles as a TYPED failed node.
  const callTool = async (
    node: WorkflowV2.CallNode,
    ctx: DagNodeContext,
  ): Promise<NodeOutcome> => {
    const servers = listMcpServersRegistry({ projectId: opts.projectId, includeGlobals: true });
    const row =
      servers.find((s) => s.name === node.server && s.scope === 'project') ??
      servers.find((s) => s.name === node.server) ??
      null;
    if (!row) {
      return {
        state: 'failed',
        error: `MCP server "${node.server}" is not registered (project or global) — add it under Settings → MCP Servers before using it in a workflow`,
      };
    }

    // Render args: every string leaf gets the same substitution pipeline as an
    // agent task ($refs + $carry.* + {{input}} ports); other JSON passes through.
    const resolvedInputs: Record<string, string> = {};
    for (const [name, expr] of Object.entries(node.input ?? {})) {
      resolvedInputs[name] = render(expr, ctx);
    }
    const renderArg = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return substituteInputs(render(value, ctx), resolvedInputs);
      }
      if (Array.isArray(value)) return value.map(renderArg);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, renderArg(v)]),
        );
      }
      return value;
    };
    const args = renderArg(node.args ?? {}) as Record<string, unknown>;

    const caller = opts.mcpToolCaller ?? callMcpTool;
    const startedAt = Date.now();
    // Slice 8+ will call resolveTransportSecrets here. Until then, cast to
    // PodMcpServerConfig (safe for plain-string transports; Slice 2 migrated
    // any pre-existing plaintext to refs, so this only fires for un-migrated
    // servers — which cannot exist after migration runs at boot).
    const result = await caller(row.transport as unknown as PodMcpServerConfig, node.tool, args, node.timeout);
    const durationMs = Date.now() - startedAt;

    // Diary line: which external action ran, where, and how it went — the
    // call-node analogue of agent_dispatched (FD-11 debugging cross-link).
    runGateway.appendRunEvent({
      projectId: opts.projectId,
      runId: run.id,
      type: 'tool_called',
      nodeId: node.id,
      data: {
        server: node.server,
        tool: node.tool,
        ok: result.status === 'ok',
        durationMs,
        ...(result.status === 'failed' ? { error: result.error } : {}),
      },
    });

    if (result.status === 'failed') {
      return {
        state: 'failed',
        error: `call ${node.server}.${node.tool} failed: ${result.error}`,
      };
    }
    // Cap the captured output so a huge tool result can't bloat dag_state (the
    // sidecar row is re-read and re-written on every persist).
    const output =
      result.output.length > CALL_OUTPUT_MAX_CHARS
        ? `${result.output.slice(0, CALL_OUTPUT_MAX_CHARS)}\n…[truncated ${String(result.output.length - CALL_OUTPUT_MAX_CHARS)} chars]`
        : result.output;
    return { state: 'completed', output };
  };

  // Card-move step (FD-9 — a drawn step, not a hidden property). Returns
  // ok/error; the executor fails the step honestly on a failed move.
  const moveCard = async (stage: string): Promise<{ ok: boolean; error?: string }> => {
    if (!run.workItemId) return { ok: false, error: 'run has no root work item' };
    const stages = opts.getProject().stages ?? [];
    if (!stages.some((s) => s.id === stage)) {
      return { ok: false, error: `stage "${stage}" not found in project` };
    }
    if (!getWorkItem(run.workItemId)) {
      return { ok: false, error: `run root work item ${run.workItemId} not found` };
    }
    // FD-12 — move + receipt in one gateway transaction; row gone → no event.
    const committed = workItemGateway.tryCommitWorkItemChange({
      projectId: opts.projectId,
      mutate: () => {
        const moved = moveWorkItemStage(run.workItemId!, stage);
        return moved ? { row: moved, reason: 'moved' } : null;
      },
    });
    // Positive receipt: a move the gateway didn't commit (row vanished between
    // the pre-checks and the txn, or the repo rejected it) must not read as
    // success — the executor fails the step honestly (FD-9).
    if (!committed) {
      return { ok: false, error: `card move to stage "${stage}" did not commit` };
    }
    return { ok: true };
  };

  // pc-pty-chat-270 Chunk B step 6 — engine-executed, verified git merge.
  //
  // Safety: ALL git operations (merge, push, state-check) run inside
  // WorktreeService, which delegates them to a dedicated engine-controlled
  // dev worktree (`<baseDir>/__dev-merge/`) — NEVER in the user's main
  // working tree (`workspaceDir`). WorktreeService.mergeBranchIntoDev also
  // asserts the dev worktree is on `dev` and clean before touching anything;
  // a precondition violation throws (caught below → `failed` outcome) and the
  // merge is never attempted. This is pc-pty-chat-270.3.
  //
  // Idempotent: reads git state FIRST so a re-entry (after conflict resolution,
  // or after a mid-merge crash + boot reconcile re-drive) handles every case
  // without re-doing work already done.
  const mergeToIntegration = async (
    node: WorkflowV2.MergeNode,
    _ctx: DagNodeContext,
  ): Promise<{ outcome: 'merged' | 'conflict' | 'failed'; error?: string }> => {
    if (!run.worktreePath) {
      return { outcome: 'failed', error: 'run has no worktree — cannot merge' };
    }
    // Branch name = last segment of the worktree path (set by ensureWorktree).
    const branch = basename(run.worktreePath);
    if (!branch) {
      return { outcome: 'failed', error: `cannot derive branch name from worktree path: ${run.worktreePath}` };
    }

    // Resolve the merge target up front. A resolver failure (no configured
    // branch + nothing detectable, or a configured branch missing from the
    // repo) fails the node LOUDLY with the fix-it message on the run.
    let into: string;
    try {
      into = await opts.worktrees.integrationBranch();
    } catch (err) {
      return { outcome: 'failed', error: (err as Error).message };
    }

    // Worktree teardown — the branch has verifiably landed (both positive
    // receipts), so the run worktree + branch have no further purpose.
    // Best-effort: a teardown failure (Windows file lock, etc.) must never
    // fail an already-merged node; the sweep retries leftovers.
    const teardownBestEffort = async (): Promise<void> => {
      try {
        await opts.worktrees.teardownAfterMerge(branch);
      } catch (err) {
        console.warn(
          `[dag-run] worktree teardown after merge failed for "${branch}" (sweep will retry): ${(err as Error).message}`,
        );
      }
    };

    const emitConflict = async (): Promise<void> => {
      // Board visibility: move card to on_conflict_stage (documented side-effect
      // of the merge node — FD-9 exception, per the build decisions). A failed
      // move must not fail the conflict signal itself, but it can't vanish
      // either — record it on the git_conflict event so the paused run explains
      // why the card never moved.
      let cardMoveError: string | undefined;
      if (node.on_conflict_stage) {
        try {
          await moveCard(node.on_conflict_stage);
        } catch (err) {
          cardMoveError = (err as Error).message ?? 'unknown error';
        }
      }
      runGateway.appendRunEvent({
        projectId: opts.projectId,
        runId: run.id,
        type: 'git_conflict',
        nodeId: node.id,
        data: cardMoveError ? { branch, cardMoveError } : { branch },
      });
    };

    try {
      // Idempotent reconcile — read actual git state before doing anything.
      const state = await opts.worktrees.mergeState(branch);

      if (state.mergeInProgress) {
        // MERGE_HEAD present: a prior (interrupted) merge attempt left a conflict.
        await emitConflict();
        return { outcome: 'conflict' };
      }

      if (state.alreadyMerged) {
        // Branch tip is already an ancestor of the integration branch — skip
        // the merge itself.
        if (!state.pushed) {
          // Push + positive receipt #2.
          try {
            await opts.worktrees.pushIntegration();
          } catch (pushErr) {
            const msg = (pushErr as Error).message ?? '';
            if (/rejected|non-fast-forward/i.test(msg)) {
              await emitConflict();
              return { outcome: 'conflict' };
            }
            return { outcome: 'failed', error: `push to origin/${into} failed: ${msg}` };
          }
          const afterPush = await opts.worktrees.mergeState(branch);
          if (!afterPush.pushed) {
            return {
              outcome: 'failed',
              error: `push to origin/${into} completed but origin/${into} != ${into}`,
            };
          }
        }
        runGateway.appendRunEvent({
          projectId: opts.projectId,
          runId: run.id,
          type: 'git_merged',
          nodeId: node.id,
          data: { branch, into, idempotent: true },
        });
        await teardownBestEffort();
        return { outcome: 'merged' };
      }

      // Fresh merge: merge → positive receipt #1 → push → positive receipt #2.
      await opts.worktrees.mergeBranchIntoIntegration(branch);

      // Positive receipt #1: branch tip must now be an ancestor of the
      // integration branch.
      const afterMerge = await opts.worktrees.mergeState(branch);
      if (!afterMerge.alreadyMerged) {
        return {
          outcome: 'failed',
          error: `merge ran but branch tip is not an ancestor of ${into} — merge commit not found`,
        };
      }

      // Push to the origin integration branch.
      try {
        await opts.worktrees.pushIntegration();
      } catch (pushErr) {
        const msg = (pushErr as Error).message ?? '';
        if (/rejected|non-fast-forward/i.test(msg)) {
          await emitConflict();
          return { outcome: 'conflict' };
        }
        return { outcome: 'failed', error: `push to origin/${into} failed: ${msg}` };
      }

      // Positive receipt #2: the origin integration branch must equal local.
      const afterPush = await opts.worktrees.mergeState(branch);
      if (!afterPush.pushed) {
        return {
          outcome: 'failed',
          error: `push to origin/${into} completed but origin/${into} != ${into}`,
        };
      }

      runGateway.appendRunEvent({
        projectId: opts.projectId,
        runId: run.id,
        type: 'git_merged',
        nodeId: node.id,
        data: { branch, into },
      });
      await teardownBestEffort();
      return { outcome: 'merged' };

    } catch (err) {
      const msg = (err as Error).message ?? 'unknown error';
      // Conflict thrown by mergeBranchIntoIntegration (git exits non-zero).
      if (/conflict|CONFLICT|Automatic merge failed/i.test(msg)) {
        await emitConflict();
        return { outcome: 'conflict' };
      }
      return { outcome: 'failed', error: msg };
    }
  };

  const requestReview = async (
    node: WorkflowV2.ReviewNode,
    ctx: DagNodeContext,
    bundle: { nodeId: string; output: string }[],
    reviewOpts: { iteration: number; escalated: boolean }
  ): Promise<void> => {
    const flavor = node.reviewer;
    const summary = bundle.map((b) => `### ${b.nodeId}\n${b.output}`).join('\n\n');
    const prompt = node.prompt ? renderBody(node.prompt, node.input, ctx) : 'Please review the work below.';
    // Derive the instance token — must mirror the formula in dag-executor.ts
    // (markAwaitingReview / ceiling re-stamp) so the token in the payload
    // matches the openReviewInstance stamped on the node record.
    const deliveryInstanceToken =
      `i${String(reviewOpts.iteration)}` + (reviewOpts.escalated ? ':escalated' : '');

    // pc-pty-chat-221 — decision-contract header. Every review surface opens
    // with a system-generated block stating lifecycle position, approve/reject
    // effects, and what verification is possible. maxRounds comes from the loop
    // node's max_iterations (null = unlimited, undefined = no reject loop).
    const loopNode = node.reject
      ? (workflow.nodes.find((n) => n.id === node.reject && n.kind === 'loop') as WorkflowV2.LoopNode | undefined)
      : undefined;
    const maxRounds = loopNode?.max_iterations ?? null;
    const decisionContract = buildDecisionContract({
      lifecyclePosition: 'completed-work',
      maxRounds: typeof maxRounds === 'number' ? maxRounds : null,
    });
    const headerText = decisionContractHeaderText(decisionContract);

    const body =
      `[pc:workflow-review run=${run.id} node=${node.id} flavor=${flavor} instance=${deliveryInstanceToken}]\n` +
      headerText + '\n\n' +
      `${prompt}\n\n${summary}\n\n` +
      `Approve: pc_complete_node-equivalent (v2 review endpoint) · Reject sends it back.`;
    // M8 (FD-7) — EVERY review flavor delivers (pre-M8 only the orchestrator
    // flavor did; a human gate paused the run invisibly). The seam routes:
    // orchestrator → active-orchestrator turn · human → user-inbox card.
    // Iteration-keyed idempotency: a loop kick-back's re-review is a NEW
    // message, not a dedupe no-op (FD-8 — pre-M8 the second prompt for the
    // same gate silently never delivered).
    // Phase 1.1 — build the unified ReviewPackage envelope (additive: carried
    // alongside the existing payload fields, existing consumers unchanged).
    const { owner } = classifyInboxItem('workflow-review', flavor);
    const title = reviewOpts.escalated
      ? `Review needed (agent loop exhausted): ${workflow.name}`
      : `Review needed: ${workflow.name}`;
    const reviewPackage = makeReviewPackage({
      id: newId(),
      producer: 'workflow-gate',
      owner,
      title,
      whatWasAsked: prompt,
      acceptanceCriteria: '',
      work: { kind: 'prose', text: summary || prompt },
      provenance: {
        agentRunId: null,
        workItemId: run.workItemId ?? null,
        workflowNodeId: node.id,
        dispatchedAt: Date.now(),
      },
      attemptHistory: [{ attempt: reviewOpts.iteration + 1, submittedAt: Date.now() }],
      // pc-pty-chat-221 — decision contract so every surface knows what it is deciding.
      decisionContract,
    });

    opts.deliverReview?.({
      projectId: opts.projectId,
      runId: run.id,
      nodeId: node.id,
      flavor,
      body,
      subject: title,
      payload: {
        runId: run.id,
        nodeId: node.id,
        flavor,
        workflowName: workflow.name,
        workItemId: run.workItemId,
        prompt,
        summary,
        bundle,
        escalated: reviewOpts.escalated,
        iteration: reviewOpts.iteration,
        // Instance token: the UI / orchestrator must echo this back with the
        // decision so a stale pre-ceiling card cannot resolve the new escalated
        // gate (instance-mismatch guard in applyReviewDecision).
        instanceToken: deliveryInstanceToken,
        // Phase 1.1 — unified ReviewPackage envelope (additive).
        reviewPackage,
      },
      idempotencyKey:
        `workflow-review:${run.id}:${node.id}:i${String(reviewOpts.iteration)}` +
        (reviewOpts.escalated ? ':escalated' : ''),
    });
    // Slice 015b — durable workflow.review.changed (pending) fact via the
    // gateway's in-txn live_outbox row. The 015a relay drains + delivers it;
    // the web `scanWorkflowLiveEvents` consumer reads the canonical frame. The
    // old hand-fanned frame + legacy `workflow-v2-review-pending` envelope are
    // deleted — delivery flows through the door only.
    runGateway.commitReviewChange({
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
    callTool,
    moveCard,
    mergeToIntegration,
    requestReview,
    persist,
    // M3a — every executor diary line through THE door: event row +
    // workflow.run.event outbox fact in one txn (was a direct repo write,
    // the FD-12 bypass #2).
    event: (ev) => {
      runGateway.appendRunEvent({
        projectId: opts.projectId,
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
        // Incident = resumes so far (diary `run_resumed` count) — see the
        // WorkflowRunFailedDelivery doc for why this keys the card.
        incident: workflowRunsV2Repo
          .listEvents(run.id)
          .filter((e) => e.type === 'run_resumed').length,
      }),
    notifyRunCompleted: () =>
      opts.deliverRunCompleted?.({
        projectId: opts.projectId,
        runId: run.id,
        workflowId: workflow.id,
        workflowName: workflow.name,
        workItemId: run.workItemId ?? null,
      }),
    // ☠ holdForHuman (M6 slice C / FD-11): the ceiling now PAUSES the run as an
    // escalated HUMAN review gate (executor re-posts via requestReview) instead
    // of failing it — the no-op seam is gone.
  };
}

export interface FireResult {
  runId: ULID;
  rootWorkItemId: ULID;
  /** Resolves when the run pauses (review), completes, or fails. */
  done: Promise<RunStatus>;
}

/**
 * Fire a v2 workflow. The ONLY two callers are the fire route ("Run now" /
 * `pc_fire_workflow`) — stage-entry firing is ☠ (M6/FD-10).
 *
 * When `rootWorkItemId` is supplied: the existing card becomes the run root —
 * no new work item is minted, its stage is unchanged, and `isWorkflowRoot` is
 * not set on it. Child-node `parentWorkItemId` and the worktree acquire still
 * hang off that card.
 *
 * When absent: a blank root work item is created in stage[0] with
 * `isWorkflowRoot: true`, preserving the previous behaviour.
 *
 * `done` resolves at the first pause/terminal; callers that don't want to block
 * (HTTP route) ignore it.
 */
export async function fireDagWorkflow(
  workflow: WorkflowV2.Workflow,
  opts: DagRunServiceOptions,
  rootWorkItemId?: ULID,
): Promise<FireResult> {
  let rootWiId: ULID;

  if (rootWorkItemId) {
    const existing = getWorkItem(rootWorkItemId);
    if (!existing) throw new Error(`root work item not found: ${rootWorkItemId}`);
    rootWiId = rootWorkItemId;
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
    workItemId: rootWiId,
    worktreePath,
    status: 'running',
  });
  workflowRunsV2Repo.markStarted(run.id);
  // Announce creation so the right rail shows the new run immediately.
  // Re-read after markStarted so the snapshot carries the started rev.
  const startedRow = workflowRunsV2Repo.getRun(run.id);
  if (startedRow) announceRunCreated(startedRow, opts.projectId, opts.broadcast);
  // M3a — the diary's opening line (declared in the union since 19.3, never
  // written until now).
  runGateway.appendRunEvent({
    projectId: opts.projectId,
    runId: run.id,
    type: 'workflow_started',
    data: { workflowName: workflow.name },
  });

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

/** Discriminated result for review decisions (build-plan steps 2+5). */
export type V2ReviewDecisionResult =
  | { ok: true; status: RunStatus }
  | { ok: false; code: 'not-found' }
  | { ok: false; code: ReviewRejected; error: string };

/**
 * Resume a paused run to apply a review decision.
 *
 * Serialized per runId (build-plan step 4): a per-run in-process lock prevents
 * two near-simultaneous decisions from both reading `awaiting-review` and each
 * firing advance() → two concurrent agents in the same worktree.
 *
 * Commit-then-drive (build-plan step 8): the decision is committed (state
 * mutated + persisted + inbox cards actioned + review fact emitted) before the
 * HTTP response returns. advance() runs on a detached task so a reject that
 * triggers an agent dispatch does not block the caller (fixes MCP transport drop
 * on pc_complete_node under heavy dispatch latency).
 */
// Internal shape carries the executor through the lock boundary.
type _LockOutcome =
  | { ok: true; status: RunStatus; _exec: DagExecutor }
  | { ok: false; code: 'not-found' }
  | { ok: false; code: ReviewRejected; error: string };

export async function applyV2ReviewDecision(
  runId: ULID,
  reviewNodeId: string,
  decision: ReviewDecision,
  opts: DagRunServiceOptions,
  instanceToken?: string,
): Promise<V2ReviewDecisionResult> {
  const lockOutcome = await withRunLock(runId, async (): Promise<_LockOutcome> => {
    const run = workflowRunsV2Repo.getRun(runId);
    if (!run) return { ok: false, code: 'not-found' };

    const workflow = JSON.parse(run.workflowYamlSnapshot) as WorkflowV2.Workflow;
    const deps = makeExecutorDeps(
      { id: run.id, workItemId: run.workItemId, worktreePath: run.worktreePath },
      workflow,
      opts,
    );
    const exec = DagExecutor.resume(workflow, run.dagState, deps, {
      runId: run.id,
      rootWorkItemId: run.workItemId,
      worktreePath: run.worktreePath,
    });

    // M8 (FD-7) — snapshot the gate's open inbox cards BEFORE deciding: a card
    // the decision itself mints (ceiling escalation, same `${runId}:${nodeId}`
    // source) must stay open. After a successful decision, action the snapshot
    // so a gate decided through ANY door clears everywhere.
    const reviewSourceId = `${run.id}:${reviewNodeId}`;
    const openCards =
      opts.reviewInbox?.collectUnactionedRecipients('workflow-run-node', reviewSourceId) ?? [];

    // ── Commit phase (fast, synchronous-ish) ──────────────────────────────
    // Apply decision + persist state. Guard fires here if gate is not open.
    const commit = await exec.commitReviewDecision(reviewNodeId, decision, instanceToken);

    if (commit.rejected) {
      return {
        ok: false,
        code: commit.rejected,
        error: `gate "${reviewNodeId}" is not awaiting review — decision ignored`,
      };
    }

    // ── Side-effects that must fire before the response ───────────────────
    // Step 9 (build-plan): card-action + emitReviewFact on the response path.
    if (openCards.length > 0) opts.reviewInbox?.actionRecipients(openCards, Date.now());

    // Slice 004 — durable workflow.review.changed (approved/rejected) fact.
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

    return { ok: true, status: commit.status, _exec: exec };
  });

  // ── Drive phase (async, outside the lock) ─────────────────────────────────
  // advance() dispatches+awaits agents; could block for minutes. Run it
  // detached so the HTTP response is already sent (build-plan step 8).
  // Errors in the async advance land on the run's normal failure path (the
  // executor's finalize() persists `failed` + notifyRunFailed fires — R1).
  if (lockOutcome.ok) {
    const exec = lockOutcome._exec;
    setImmediate(() => {
      exec.advance().catch((err: Error) => {
        console.error(`[dag-run] async advance after review decision failed for run ${runId}:`, err.message);
      });
    });
    // Strip the internal _exec field before returning externally.
    return { ok: true, status: lockOutcome.status };
  }

  return lockOutcome;
}

export type ResumeFailedRunResult =
  | { ok: true; runId: ULID; status: RunStatus; defChanged: boolean; resetNodes: string[] }
  | { ok: false; code: 'not-found' | 'not-failed' | 'no-definition' | 'incompatible'; error: string };

/**
 * M6 slice C — FD-11 req 2+3: restart-at-step / the repair loop. Resume a
 * FAILED run: re-freeze the CURRENT definition as the run's new snapshot
 * (compat-checked — every node the run already settled must still exist), reset
 * failed/skipped/ghost nodes to pending (completed work is KEPT), flip the run
 * back to running with a `run_resumed` diary line, and re-advance. This is the
 * ONE door through which an edited definition reaches an existing run.
 */
export async function resumeFailedDagRun(
  runId: ULID,
  currentDefinition: WorkflowV2.Workflow | null,
  opts: DagRunServiceOptions,
): Promise<ResumeFailedRunResult> {
  const run = workflowRunsV2Repo.getRun(runId);
  if (!run) return { ok: false, code: 'not-found', error: `unknown run: ${runId}` };
  if (run.status !== 'failed') {
    return {
      ok: false,
      code: 'not-failed',
      error: `run is ${run.status} — only failed runs can be resumed from their failed step`,
    };
  }
  if (!currentDefinition) {
    return {
      ok: false,
      code: 'no-definition',
      error: `the workflow definition "${run.workflowId}" is missing or invalid — repair it before resuming`,
    };
  }

  // Compat-check against the FROZEN snapshot too: a settled node whose kind
  // changed in the edit must not carry its kept state into a different kind
  // of step.
  let previousDef: WorkflowV2.Workflow | undefined;
  try {
    previousDef = JSON.parse(run.workflowYamlSnapshot) as WorkflowV2.Workflow;
  } catch {
    previousDef = undefined; // unreadable snapshot — existence check still runs
  }
  const compat = resumeCompatErrors(currentDefinition, run.dagState, previousDef);
  if (compat.length > 0) {
    return {
      ok: false,
      code: 'incompatible',
      error: `the edited definition is incompatible with this run's kept work: ${compat.join('; ')}`,
    };
  }

  const frozen = JSON.stringify(currentDefinition);
  const defChanged = frozen !== run.workflowYamlSnapshot;
  const { state: resetState, resetNodes } = resetFailedNodesForResume(
    currentDefinition,
    run.dagState,
  );

  // One gateway txn: new snapshot + reset state + status running + the
  // workflow.run.changed fact. The diary line rides its own gateway write.
  runGateway.commitRunChange({
    projectId: opts.projectId,
    reason: 'advanced',
    mutate: () => {
      workflowRunsV2Repo.setWorkflowYamlSnapshot(runId, frozen);
      workflowRunsV2Repo.setDagState(runId, resetState);
      workflowRunsV2Repo.setStatus(runId, 'running', { lastReason: null });
      return workflowRunsV2Repo.getRun(runId);
    },
  });
  runGateway.appendRunEvent({
    projectId: opts.projectId,
    runId,
    type: 'run_resumed',
    data: { resetNodes, defChanged },
  });

  const deps = makeExecutorDeps(
    { id: run.id, workItemId: run.workItemId, worktreePath: run.worktreePath },
    currentDefinition,
    opts,
  );
  const exec = DagExecutor.resume(currentDefinition, resetState, deps, {
    runId: run.id,
    rootWorkItemId: run.workItemId,
    worktreePath: run.worktreePath,
  });
  // S5/FD-14 — resumed-through-ANY-door (inbox card / pc_resume_workflow_run /
  // raw HTTP) actions the run's open `workflow-run-failed` cards so they never
  // linger. A later failure mints a FRESH card (incident-keyed idempotency).
  const openFailureCards =
    opts.reviewInbox?.collectUnactionedRecipients('workflow-run', runId) ?? [];
  if (openFailureCards.length > 0)
    opts.reviewInbox?.actionRecipients(openFailureCards, Date.now());

  // Advance in the background (mirrors fireDagWorkflow) — the route returns a
  // receipt now; the run proceeds + broadcasts on its own.
  exec.advance().catch((err: Error) => {
    console.error(`[dag-run] resumed run ${runId} failed:`, err.message);
  });

  return { ok: true, runId, status: 'running', defChanged, resetNodes };
}
