// Section 19.4e — LIVE wiring for the v2 DAG executor. Implements DagExecutorDeps
// against the real machinery (work-item-as-contract creation, spawnSubagent,
// verification, worktree exec, channel posts, the v2 sidecar repo) and provides
// the fire entry point. Spawner / verification / exec / channel are injectable
// so the integration is testable against a real DB with a FAKE claude.exe (see
// test/dag-run-service.test.ts); the live claude.exe smoke is 19.14.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentRunFailureCause, ExpectedOutput, Project, ULID, WorkflowV2 } from '@pc/domain';
import { substituteRefs, type RefResolver, type ReviewDecision, type RunStatus } from '@pc/workflows';
import {
  getAgentRunRow,
  getWorkItem,
  insertAgentRunRow,
  markAgentRunTerminal,
  moveWorkItemStage,
  newId,
  resolveAgentForDispatch,
  setAssignedAgentRunId,
  updateAgentRunStatus,
  workflowRunsV2Repo,
} from '@pc/db';
import {
  spawnSubagent,
  type AgentHostCommandResponse,
  type AgentHostEvent,
  type AgentHostWorkflowSubagentSnapshot,
  type SubagentSpawnHandle,
  type SubagentSpawnRequest,
  type SubagentSpawnResult,
} from '@pc/runtime';
import { DagExecutor, type DagExecutorDeps, type DagNodeContext, type NodeOutcome } from './dag-executor.ts';
import { announceRunCreated, writeDagAndStatus } from './workflow-run-writer.ts';
import { announceAgentRunChange } from './agent-run-writer.ts';
import { WorkflowRunMutationGateway } from '@pc/app-services';
import {
  buildLiveEventFrame,
  buildWorkflowReviewPendingRefetchEnvelope,
  type WorkflowReviewFlavor,
  type WorkflowReviewState,
} from '@pc/contracts';
import { createAgentWorkItem } from './agent-work-item.ts';
import { runVerificationOnTerminal } from './agent-verification.ts';
import { preparePodSpawn } from './pod-spawn.ts';
import { registerWorkflowSubagentHandshake } from './workflow-subagent-handshake.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';
import type { WorkItemService } from './work-item.ts';
import { announceWorkItemRow } from './work-item-writer.ts';
import type { WorktreeService } from './worktree.ts';

const execFileAsync = promisify(execFile);

export type Spawner = (req: SubagentSpawnRequest) => SubagentSpawnHandle;
export type Verifier = typeof runVerificationOnTerminal;
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

export type ChannelPoster = (body: string, source: string) => Promise<void>;

/** Slice 008 — workflow-review delivery seam. When the workflow-review gate
 *  resolves to `mailbox`, the DAG executor calls this instead of `postChannel`
 *  to enqueue a durable `workflow-review` mailbox message (active-orchestrator
 *  + orchestrator-turn). When it returns `false` (no port / gate=channel) the
 *  caller falls back to `postChannel`. Injected from index.ts where the
 *  mailboxService lives — ProjectRuntime never gains a mailbox ref. The
 *  slice-004 workflow.review.changed fact fires regardless (it is state, not
 *  delivery). */
export type WorkflowReviewDelivery = (input: {
  projectId: ULID;
  runId: ULID;
  nodeId: string;
  flavor: WorkflowReviewFlavor;
  body: string;
}) => boolean;

// Slice 004 — durable workflow.review.changed facts via the run gateway. The
// run-row state still flows through workflow-run-writer; this is the review
// audit/action surface that mirrors the transient workflow-v2-review-pending.
const reviewGateway = new WorkflowRunMutationGateway();

function emitReviewFact(
  opts: { projectId: ULID; broadcast: (event: unknown) => void },
  input: {
    runId: ULID;
    nodeId: string;
    flavor: WorkflowReviewFlavor;
    state: WorkflowReviewState;
    prompt?: string | null;
    notes?: string;
  },
): void {
  const pub = reviewGateway.commitReviewChange({
    projectId: opts.projectId,
    runId: input.runId,
    nodeId: input.nodeId,
    flavor: input.flavor,
    state: input.state,
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
  opts.broadcast(buildLiveEventFrame(pub.liveEvent));
  // Legacy compat: only the pending state had a transient broadcast name.
  if (input.state === 'pending') {
    opts.broadcast(
      buildWorkflowReviewPendingRefetchEnvelope({
        projectId: opts.projectId,
        runId: input.runId,
        nodeId: input.nodeId,
        flavor: input.flavor,
        prompt: input.prompt ?? null,
      }),
    );
  }
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
  /** Per-dispatch session-data dir factory (mirrors WorkflowRuntime). */
  sessionDirFor: (pcSessionId: string) => string;
  broadcast: (event: unknown) => void;
  hostClient?: AgentHostReattachClient | null;
  // ── injectable seams (live defaults) ──
  spawner?: Spawner;
  verify?: Verifier;
  exec?: CommandExec;
  postChannel?: ChannelPoster;
  /** Slice 008 — gated mailbox review delivery. When present and it returns
   *  true, the review prompt was enqueued as a mailbox message and `postChannel`
   *  is skipped. Default (absent) keeps the unchanged Channel path. */
  deliverReview?: WorkflowReviewDelivery;
}

const liveSpawner: Spawner = (req) =>
  spawnSubagent(req, { registerHandshakeListener: registerWorkflowSubagentHandshake });

function hostBackedWorkflowSpawner(hostClient: AgentHostReattachClient): Spawner {
  return (req) => {
    let snapshot: AgentHostWorkflowSubagentSnapshot | null = null;
    let settled = false;
    let unsubscribe: (() => void) | void;
    let resolveDone!: (result: SubagentSpawnResult) => void;
    const done = new Promise<SubagentSpawnResult>((resolveDoneInner) => {
      resolveDone = resolveDoneInner;
    });

    const cleanup = (): void => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = undefined;
      }
    };

    const settle = (result: SubagentSpawnResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveDone(result);
    };

    const fail = (message: string): void => {
      settle(hostWorkflowFailure(req, snapshot, 'spawn-error', message));
    };

    const applySnapshot = (next: AgentHostWorkflowSubagentSnapshot): void => {
      if (!workflowSnapshotMatchesRequest(req, next)) return;
      snapshot = next;
      if (next.terminalResult) {
        settle(next.terminalResult);
        return;
      }
      if (isTerminalWorkflowState(next.state)) {
        settle(
          hostWorkflowFailure(
            req,
            next,
            next.state === 'cancelled' ? 'killed' : 'spawn-error',
            'workflow subagent host terminal event omitted result',
          ),
        );
      }
    };

    unsubscribe = hostClient.onEvent?.((event: AgentHostEvent) => {
      if (
        (event.type === 'workflow-subagent-state' ||
          event.type === 'workflow-subagent-terminal') &&
        event.workflowSubagent.pcSessionId === req.pcSessionId
      ) {
        applySnapshot(event.workflowSubagent);
      }
    });

    Promise.resolve(
      hostClient.sendCommand({
        type: 'start-workflow-subagent',
        request: req,
      }),
    )
      .then((response) => {
        if (settled) return;
        applyStartWorkflowSubagentResponse(req, response, applySnapshot, fail);
      })
      .catch((err) => {
        if (!settled) fail(`agent host start-workflow-subagent failed: ${errorMessage(err)}`);
      });

    return {
      done,
      kill: (reason?: string) => {
        if (settled) return;
        Promise.resolve(
          hostClient.sendCommand({
            type: 'cancel-workflow-subagent',
            pcSessionId: req.pcSessionId,
            reason,
          }),
        )
          .then((response) => {
            if (!response) {
              settle(hostWorkflowFailure(req, snapshot, 'killed', reason ?? 'cancelled'));
              return;
            }
            if (!response.ok) {
              settle(
                hostWorkflowFailure(
                  req,
                  snapshot,
                  'killed',
                  `agent host cancel-workflow-subagent failed: ${response.error}`,
                ),
              );
              return;
            }
            if (response.command === 'cancel-workflow-subagent') {
              applySnapshot(response.workflowSubagent);
            }
          })
          .catch((err) => {
            settle(
              hostWorkflowFailure(
                req,
                snapshot,
                'killed',
                `agent host cancel-workflow-subagent failed: ${errorMessage(err)}`,
              ),
            );
          });
      },
      transcriptPath: () => snapshot?.transcriptPath ?? resolve(req.sessionDataDir, 'transcript.log'),
      jsonlPath: () => snapshot?.jsonlPath ?? null,
    };
  };
}

function applyStartWorkflowSubagentResponse(
  req: SubagentSpawnRequest,
  response: AgentHostCommandResponse | void,
  applySnapshot: (snapshot: AgentHostWorkflowSubagentSnapshot) => void,
  fail: (message: string) => void,
): void {
  if (!response) {
    fail('agent host start-workflow-subagent returned no response');
    return;
  }
  if (!response.ok) {
    fail(`agent host start-workflow-subagent failed: ${response.error}`);
    return;
  }
  if (response.command !== 'start-workflow-subagent') {
    fail(`agent host returned ${response.command} for start-workflow-subagent`);
    return;
  }
  if (!workflowSnapshotMatchesRequest(req, response.workflowSubagent)) {
    fail('agent host returned mismatched workflow subagent snapshot');
    return;
  }
  applySnapshot(response.workflowSubagent);
}

function workflowSnapshotMatchesRequest(
  req: SubagentSpawnRequest,
  snapshot: AgentHostWorkflowSubagentSnapshot,
): boolean {
  return (
    snapshot.pcSessionId === req.pcSessionId &&
    snapshot.agentName === req.agentName &&
    snapshot.worktreeDir === req.worktreeDir
  );
}

function isTerminalWorkflowState(
  state: AgentHostWorkflowSubagentSnapshot['state'],
): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function hostWorkflowFailure(
  req: SubagentSpawnRequest,
  snapshot: AgentHostWorkflowSubagentSnapshot | null,
  cause: Extract<SubagentSpawnResult, { kind: 'failure' }>['cause'],
  message: string,
): SubagentSpawnResult {
  return {
    kind: 'failure',
    cause,
    message,
    transcriptPath: snapshot?.transcriptPath ?? resolve(req.sessionDataDir, 'transcript.log'),
    jsonlPath: snapshot?.jsonlPath ?? null,
    partialAssistantText:
      snapshot?.terminalResult?.kind === 'failure'
        ? snapshot.terminalResult.partialAssistantText
        : '',
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  const spawner = opts.spawner ?? (opts.hostClient ? hostBackedWorkflowSpawner(opts.hostClient) : liveSpawner);
  const verify = opts.verify ?? runVerificationOnTerminal;
  const exec = opts.exec ?? liveExec;
  const postChannel =
    opts.postChannel ??
    (async (body, source) => {
      const slug = opts.getProject().slug;
      const url = `http://127.0.0.1:${String(opts.channelPort)}/channel/${encodeURIComponent(slug)}/${encodeURIComponent(source)}`;
      await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
    });

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

    // Issue #3 — consult pod row's expected_output before the stock map.
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
        getPodRowExpectedOutput: (podName) => {
          const row = resolveAgentForDispatch(podName, opts.projectId);
          return row?.expectedOutput as ExpectedOutput | null | undefined;
        },
      }
    );

    const worktreeDir = run.worktreePath ?? opts.workspaceDir;
    const pcSessionId = `wf-${run.id.slice(-8)}-${node.id}-${randomUUID().slice(0, 8)}`;
    const sessionDataDir = opts.sessionDirFor(pcSessionId);
    mkdirSync(sessionDataDir, { recursive: true });

    const podPrep = preparePodSpawn({
      agentName: node.agent,
      projectId: opts.projectId,
      worktreeDir,
      scratchDir: sessionDataDir,
      filterMcpToReferencedTools: true,
      dataDir: opts.dataDir,
      templatesDir: opts.templatesDir,
      trunkPath: opts.trunkPath,
      serverPort: opts.serverPort,
      channelPort: opts.channelPort,
    });
    if (!podPrep) {
      return {
        state: 'failed',
        error: `pod "${node.agent}" not found in registry`,
      };
    }
    // Project-scope enforcement: workflow nodes must use project-scoped pods.
    // Global pods are not resolvable in workflow dispatch — they must first be
    // cloned into the project via POST /api/agents/pods/:id/clone-to-project.
    if (podPrep.podScope === 'global') {
      podPrep.cleanup();
      return {
        state: 'failed',
        error: `pod "${node.agent}" is global-scope — clone it into project ${opts.projectId} before using it in a workflow node`,
      };
    }

    // Issue #1(c) — keep initialInput SHORT and single-line. A long/multi-line
    // prompt breaks the spawn echo-ack handshake (send-protocol.ts) → echo-timeout
    // (regression observed on canary-2). Worktree isolation is enforced by
    // path-guard.cjs via PC_WORKFLOW_RUN_ID / PC_WORKFLOW_WORKTREE (set below),
    // NOT by tokens in this string.
    const initialInput =
      `Your assignment is work item ${childWi.id}. Call pc_get_work_item({ id: "${childWi.id}" }) to read its body and acceptance criteria, then begin. Work only inside your worktree — all file edits and git commands must run here. When finished, update the work item with your report.`;

    // Issue #2 — insert agent_runs row so the Running Agents rail can see this agent.
    const agentRunId = newId() as ULID;
    const wfCcSessionId = randomUUID();
    const queuedAt = Date.now();
    insertAgentRunRow({
      id: agentRunId,
      projectId: opts.projectId,
      podName: node.agent,
      dispatcherSessionId: pcSessionId,
      ccSessionId: wfCcSessionId,
      status: 'queued',
      input: `[workflow: ${run.id}] [node: ${node.id}]\n${task}`,
      parentWorkItemId: childWi.id as ULID,
      parentInvokeDepth: 0,
      continues: null,
      queuedAt,
    });
    setAssignedAgentRunId(childWi.id as ULID, agentRunId);

    // Slice 015b — durable agent.run.changed announce for the workflow
    // subagent's run. Writes the in-txn `live_outbox` row (the live-relay
    // delivers the canonical frame) + re-reads the post-write row for the
    // correct rev. Replaces the old direct `agent-run-changed` hand-broadcast
    // (which the web no longer reads and wrote no outbox row).
    const broadcastRun = (
      status: 'queued' | 'running' | 'completed' | 'failed',
    ): void => {
      announceAgentRunChange(
        { runId: agentRunId, reason: status, worktreeDir, startedAt: queuedAt },
        opts.broadcast,
      );
    };
    broadcastRun('queued');

    // Issue #1(a) — set PC_WORKFLOW_RUN_ID + PC_WORKFLOW_WORKTREE so
    // path-guard.cjs enforce() activates for this top-level spawn (no
    // agent_type payload in PreToolUse for direct --agent spawns). Also
    // pass PC_AGENT_NAME for the READ_ANYWHERE_PODS exemption check.
    const handle = spawner({
      agentName: podPrep.agentCliName,
      worktreeDir,
      initialInput,
      sessionDataDir,
      pcSessionId,
      ...(node.timeout !== undefined ? { idleTimeoutMs: node.timeout } : {}),
      mcpConfigPath: podPrep.mcpConfigPath,
      settingsPath: podPrep.settingsPath,
      settingSources: podPrep.settingSources,
      pluginDirs: [podPrep.pluginDir],
      extraEnv: {
        ...podPrep.extraEnv,
        PC_WORKFLOW_RUN_ID: run.id,
        PC_WORKFLOW_WORKTREE: worktreeDir,
        PC_AGENT_NAME: node.agent,
      },
    });

    // Transition to 'running' immediately (spawner fires off the process).
    updateAgentRunStatus({ id: agentRunId, status: 'running', spawnedAt: Date.now(), readyAt: Date.now() });
    broadcastRun('running');

    let failureReason: string | null = null;
    let spawnCause: string | null = null;
    try {
      const result = await handle.done;
      if (result.kind === 'failure') {
        failureReason = `${result.cause}: ${result.message}`;
        spawnCause = result.cause;
      }
    } finally {
      podPrep.cleanup();
    }

    const outcome = await verify({
      workItemId: childWi.id as ULID,
      terminalStatus: failureReason ? 'failed' : 'completed',
      failureReason,
      projectFolderPath: opts.workspaceDir,
      worktreeDir,
      project: opts.getProject(),
    });

    const failed =
      failureReason !== null ||
      outcome?.verificationStatus === 'failed' ||
      outcome?.workItemStatus === 'failed';

    // Issue #2 — mark the agent_runs row terminal.
    const completedAt = Date.now();
    const terminalStatus = failed ? 'failed' : 'completed';
    const mappedCause: AgentRunFailureCause | null = failed
      ? (spawnCause === 'idle-timeout' ? 'idle-timeout'
        : spawnCause === 'wall-clock-timeout' ? 'wall-clock-timeout'
        : spawnCause === 'killed' ? 'cancelled'
        : 'spawn-error')
      : null;
    markAgentRunTerminal({
      id: agentRunId,
      status: terminalStatus,
      result: failed ? null : '',
      failureCause: mappedCause,
      failureReason: failureReason,
      completedAt,
    });
    // Terminal row already persisted by markAgentRunTerminal above; announce
    // re-reads it for the canonical frame.
    broadcastRun(terminalStatus);

    return {
      state: failed ? 'failed' : 'completed',
      workItemId: childWi.id as ULID,
      ...(failed && failureReason ? { error: failureReason } : {}),
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
      // Slice 008 — gated delivery. When the workflow-review gate = `mailbox`
      // and a delivery seam is wired, the review prompt is enqueued as a
      // durable mailbox message (active-orchestrator + orchestrator-turn);
      // otherwise the unchanged `postChannel` Channel path runs.
      const deliveredViaMailbox =
        opts.deliverReview?.({
          projectId: opts.projectId,
          runId: run.id,
          nodeId: node.id,
          flavor,
          body,
        }) ?? false;
      if (!deliveredViaMailbox) {
        await postChannel(body, 'workflow');
      }
    }
    // Slice 004 — durable workflow.review.changed (pending) fact + canonical
    // frame via the gateway. Then the legacy transient broadcast (unchanged
    // wire shape incl. `bundle`) for existing clients.
    const reviewPub = reviewGateway.commitReviewChange({
      projectId: opts.projectId,
      runId: run.id,
      nodeId: node.id,
      flavor,
      state: 'pending',
      prompt: node.prompt ?? null,
    });
    opts.broadcast(buildLiveEventFrame(reviewPub.liveEvent));
    opts.broadcast({
      type: 'workflow-v2-review-pending',
      projectId: opts.projectId,
      runId: run.id,
      nodeId: node.id,
      flavor,
      prompt: node.prompt ?? null,
      bundle,
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
    holdForHuman: (nodeId, reason) => {
      opts.broadcast({
        type: 'workflow-v2-human-hold',
        projectId: opts.projectId,
        runId: run.id,
        nodeId,
        reason,
      });
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
