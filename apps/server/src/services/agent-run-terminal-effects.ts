import {
  AGENT_RUN_FAILURE_CAUSES,
  type AgentFailedPayload,
  type AgentInboxEventKind,
  type AgentRunFailureCause,
  type AgentRunRow,
  type Project,
  type ULID,
  type WorkItem,
} from '@pc/domain';
import {
  getAgentRunRow as defaultGetAgentRunRow,
  getProjectById as defaultGetProjectById,
  getWorkItem as defaultGetWorkItem,
  type MarkAgentRunTerminalInput,
} from '@pc/db';

import {
  buildAgentCompletedBody,
  buildAgentFailedBody,
  type VerificationBlock,
} from './agent-event-header.ts';
import type { ActiveRunRegistry } from './agent-active-runs.ts';
import type { ChannelServer } from './channel-server.ts';
import { deliverAgentEnvelope, type MailboxEnqueuePort } from './agent-delivery.ts';
import { envDeliveryRouter, type DeliveryRouter } from './delivery-routing.ts';
import { commitAgentRunTerminal } from './agent-run-writer.ts';
import {
  runVerificationOnTerminal,
  type VerificationDeps,
  type VerificationOutcome,
} from './agent-verification.ts';

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

export interface AgentRunTerminalEffectsInput {
  runId: ULID;
  ccSessionId: string;
  podName: string;
  projectId: ULID;
  dispatcherSessionId: string;
  parentWorkItemId: ULID | null;
  worktreeDir: string;
  status: TerminalStatus;
  result?: string | null;
  failureCause?: string | null;
  failureReason?: string | null;
  defaultFailureCause?: AgentRunFailureCause | null;
  defaultFailureReason?: string | null;
  completedAt?: number | null;
  startedAt?: number | null;
  workItemId?: ULID | null;
  slug?: string | null;
  cleanup?: () => void;
}

export interface AgentRunTerminalEffectsDeps {
  activeRunRegistry?: ActiveRunRegistry;
  channelServer?: ChannelServer;
  /** Slice 008 — per-flow delivery gate (default channel). */
  deliveryRouter?: DeliveryRouter;
  /** Slice 008 — mailbox enqueue port; only consulted when the agent gate
   *  resolves to `mailbox`. Omit to force the Channel path. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  broadcast?: (projectId: ULID, msg: unknown) => void;
  getAgentRun?: (id: ULID) => AgentRunRow | null;
  /** Resolve a work item (default: real repo). Used to surface the contract
   *  deliverable as the completion result when the agent left no free-text. */
  getWorkItem?: (id: ULID) => WorkItem | null;
  markTerminal?: (input: MarkAgentRunTerminalInput) => void;
  verifyOnTerminal?: typeof runVerificationOnTerminal;
  verificationDeps?: VerificationDeps;
  now?: () => number;
  onError?: (error: Error) => void;
}

export interface AgentRunTerminalEffectsResult {
  applied: number;
}

export function applyAgentRunTerminalEffects(
  input: AgentRunTerminalEffectsInput,
  deps: AgentRunTerminalEffectsDeps = {},
): AgentRunTerminalEffectsResult {
  const row = (deps.getAgentRun ?? defaultGetAgentRunRow)(input.runId);
  if (!row || isDbTerminal(row.status)) return { applied: 0 };

  const completedAt = input.completedAt ?? (deps.now ?? Date.now)();
  const failureCause = terminalFailureCause(input);
  const failureReason =
    input.status === 'completed'
      ? null
      : input.failureReason ??
        describeAgentRunFailure(failureCause) ??
        input.defaultFailureReason ??
        input.failureCause ??
        null;

  // Slice 005 — the terminal row flip + the durable agent.run.changed fact land
  // in ONE transaction through the gateway, which re-reads the post-write row
  // for the correct rev, then we fan out canonical + legacy. When a test injects
  // a `markTerminal` override (no real DB), fall back to the direct write +
  // legacy broadcast so the gateway's getDb() path is never touched.
  if (deps.markTerminal) {
    deps.markTerminal({
      id: input.runId,
      status: input.status,
      result: input.status === 'completed' ? input.result ?? '' : null,
      failureCause,
      failureReason,
      completedAt,
    });
    emitLegacyTerminalBroadcast({ input, row, completedAt, failureCause, failureReason, deps });
  } else {
    commitAgentRunTerminal(
      {
        runId: input.runId,
        status: input.status,
        result: input.status === 'completed' ? input.result ?? '' : null,
        failureCause,
        failureReason,
        completedAt,
        worktreeDir: input.worktreeDir,
        startedAt: input.startedAt ?? row.queuedAt,
      },
      deps.broadcast ? (event) => deps.broadcast?.(input.projectId, event) : undefined,
    );
  }

  deps.activeRunRegistry?.unregister(input.runId);

  try {
    input.cleanup?.();
  } catch {
    /* best-effort */
  }

  void finishTerminalEffects({
    input,
    row,
    completedAt,
    failureCause,
    failureReason,
    deps,
  }).catch((err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    deps.onError?.(error);
  });

  return { applied: 1 };
}

async function finishTerminalEffects(args: {
  input: AgentRunTerminalEffectsInput;
  row: AgentRunRow;
  completedAt: number;
  failureCause: AgentRunFailureCause | null;
  failureReason: string | null;
  deps: AgentRunTerminalEffectsDeps;
}): Promise<void> {
  const { input, row, failureCause, failureReason, deps } = args;
  const project = safeGetProject(input.projectId);
  const workItemId = input.workItemId !== undefined ? input.workItemId : row.parentWorkItemId;

  const verifier = deps.verifyOnTerminal ?? runVerificationOnTerminal;
  let outcome: VerificationOutcome | null = null;
  if (workItemId && project) {
    outcome = await verifier(
      {
        workItemId,
        terminalStatus: input.status,
        failureReason,
        projectFolderPath: project.folderPath,
        worktreeDir: input.worktreeDir,
        project,
      },
      deps.verificationDeps ?? {},
    );
  }

  const verification: VerificationBlock | null = outcome
    ? {
        workItemId: outcome.workItemId,
        status: outcome.verificationStatus,
        tier: outcome.verificationTier,
        notes: outcome.notes,
      }
    : null;

  // Contract dispatches (work-item-as-contract): the agent reports its
  // deliverable INTO the work item and typically completes via tool calls, so
  // the free-text `result` (last assistant text) is empty. The completion event
  // would then read "Result: (no output)" and the orchestrator has nothing to
  // surface. Fall back to the work item's deliverable (body) so the envelope
  // carries the actual output. Only for completed contract runs with no text.
  let result = input.result ?? '';
  if (input.status === 'completed' && result.trim() === '' && workItemId) {
    const wi = (deps.getWorkItem ?? defaultGetWorkItem)(workItemId);
    const deliverable = wi?.body?.trim();
    if (deliverable) result = deliverable;
  }

  // Slice 005 — the rail broadcast (durable agent.run.changed) is emitted
  // SYNCHRONOUSLY by applyAgentRunTerminalEffects through the gateway; this
  // async tail keeps ONLY verification + the Channel terminal envelope.
  const slug = input.slug ?? project?.slug ?? null;
  if (deps.channelServer && slug) {
    emitTerminalEnvelope({
      channelServer: deps.channelServer,
      router: deps.deliveryRouter ?? envDeliveryRouter(),
      mailboxEnqueue: deps.mailboxEnqueue ?? null,
      projectId: input.projectId,
      dispatcherSessionId: input.dispatcherSessionId,
      slug,
      runId: input.runId,
      ccSessionId: input.ccSessionId,
      podName: input.podName,
      parentWorkItemId: row.parentWorkItemId,
      terminalStatus: input.status,
      result,
      failureCause,
      verification,
    });
  }
}

/** Legacy-only terminal broadcast for the test-injection path (markTerminal
 *  override + no real DB). Production routes through the gateway. */
function emitLegacyTerminalBroadcast(args: {
  input: AgentRunTerminalEffectsInput;
  row: AgentRunRow;
  completedAt: number;
  failureCause: AgentRunFailureCause | null;
  failureReason: string | null;
  deps: AgentRunTerminalEffectsDeps;
}): void {
  const { input, row, completedAt, failureCause, failureReason, deps } = args;
  if (!deps.broadcast) return;
  const updatedRow = (deps.getAgentRun ?? defaultGetAgentRunRow)(input.runId);
  deps.broadcast(input.projectId, {
    type: 'agent-run-changed',
    record: {
      runId: input.runId,
      sessionId: input.ccSessionId,
      agentName: input.podName,
      model: 'opus',
      projectId: input.projectId,
      parentWorkItemId: row.parentWorkItemId,
      dispatcherSessionId: input.dispatcherSessionId,
      wait: false,
      worktreeDir: input.worktreeDir,
      startedAt: input.startedAt ?? row.queuedAt,
      status: input.status,
      result: input.status === 'completed' ? input.result ?? '' : '',
      failureReason,
      failureCause,
      endedAt: completedAt,
      rev: updatedRow?.rev ?? row.rev,
    },
  });
}

interface EmitTerminalArgs {
  channelServer: ChannelServer;
  router: DeliveryRouter;
  mailboxEnqueue: MailboxEnqueuePort | null;
  projectId: ULID;
  dispatcherSessionId: string;
  slug: string;
  runId: ULID;
  ccSessionId: string;
  podName: string;
  parentWorkItemId: ULID | null;
  terminalStatus: TerminalStatus;
  result: string;
  failureCause: AgentRunFailureCause | null;
  verification: VerificationBlock | null;
}

function emitTerminalEnvelope(args: EmitTerminalArgs): void {
  const kind: AgentInboxEventKind =
    args.terminalStatus === 'completed' ? 'agent-completed' : 'agent-failed';
  const body =
    args.terminalStatus === 'completed'
      ? buildAgentCompletedBody({
          runId: args.runId,
          sessionId: args.ccSessionId,
          agentName: args.podName,
          parentWorkItemId: args.parentWorkItemId,
          result: args.result,
          verification: args.verification,
        })
      : buildAgentFailedBody({
          runId: args.runId,
          sessionId: args.ccSessionId,
          agentName: args.podName,
          parentWorkItemId: args.parentWorkItemId,
          reason: describeAgentRunFailure(args.failureCause) ?? args.terminalStatus,
          cause: agentFailureCauseToPayload(args.failureCause, args.terminalStatus),
          verification: args.verification,
        });
  deliverAgentEnvelope(
    {
      projectId: args.projectId,
      pcSessionId: args.dispatcherSessionId,
      kind,
      slug: args.slug,
      source: 'agent',
      body,
      sender: 'pc',
      idempotencyKey: `agent:${args.runId}:${kind}`,
      sourceId: args.runId,
    },
    {
      channelServer: args.channelServer,
      router: args.router,
      mailboxEnqueue: args.mailboxEnqueue,
    },
  );
}

function terminalFailureCause(
  input: AgentRunTerminalEffectsInput,
): AgentRunFailureCause | null {
  if (input.status === 'completed') return null;
  return (
    coerceFailureCause(input.failureCause) ??
    input.defaultFailureCause ??
    null
  );
}

function agentFailureCauseToPayload(
  cause: AgentRunFailureCause | null,
  terminalStatus: TerminalStatus,
): AgentFailedPayload['cause'] {
  if (terminalStatus === 'cancelled') return 'cancelled';
  switch (cause) {
    case 'wall-clock-timeout':
    case 'idle-timeout':
    case 'ready-timeout':
      return 'timeout';
    case 'cancelled':
    case 'cancel-while-queued':
      return 'cancelled';
    case 'spawn-stuck':
    case 'spawn-error':
    case 'send-failed':
    case 'unexpected-exit':
    case 'mcp-handshake-never':
    case 'kill-during-spawn':
    case 'server-restart':
    case 'host-unavailable':
    case 'host-lost':
    case 'host-crashed':
    case 'host-protocol-error':
      return 'spawn-failed';
    case null:
    default:
      return 'error';
  }
}

export function describeAgentRunFailure(
  cause: AgentRunFailureCause | null,
): string | null {
  if (!cause) return null;
  switch (cause) {
    case 'spawn-stuck':
      return 'agent never transitioned out of spawning within the spawn-stuck cap';
    case 'idle-timeout':
      return 'agent produced no output for the idle window';
    case 'wall-clock-timeout':
      return 'agent exceeded the wall-clock cap';
    case 'ready-timeout':
      return 'agent never reached ready within the ready-timeout window';
    case 'spawn-error':
      return 'agent spawn failed before becoming ready';
    case 'send-failed':
      return 'failed to deliver the initial input to the agent';
    case 'unexpected-exit':
      return 'agent process exited unexpectedly';
    case 'cancel-while-queued':
      return 'cancelled before the queue admitted the run';
    case 'cancelled':
      return 'run cancelled';
    case 'mcp-handshake-never':
      return 'agent MCP handshake never completed';
    case 'kill-during-spawn':
      return 'agent was killed during spawn';
    case 'server-restart':
      return 'server restarted before this run completed';
    case 'host-unavailable':
      return 'agent host was unavailable before the run could start';
    case 'host-lost':
      return 'agent host no longer owns this non-terminal run';
    case 'host-crashed':
      return 'agent host crashed while owning this run';
    case 'host-protocol-error':
      return 'agent host returned an invalid protocol response';
    default:
      return cause;
  }
}

function coerceFailureCause(value: string | null | undefined): AgentRunFailureCause | null {
  if (!value) return null;
  return (AGENT_RUN_FAILURE_CAUSES as readonly string[]).includes(value)
    ? (value as AgentRunFailureCause)
    : null;
}

function safeGetProject(projectId: ULID): Project | null {
  try {
    return defaultGetProjectById(projectId);
  } catch {
    return null;
  }
}

function isDbTerminal(status: AgentRunRow['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
