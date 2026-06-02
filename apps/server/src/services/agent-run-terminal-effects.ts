import {
  AGENT_RUN_FAILURE_CAUSES,
  type AgentFailedPayload,
  type AgentInboxEventKind,
  type AgentRunFailureCause,
  type AgentRunRow,
  type Project,
  type ULID,
} from '@pc/domain';
import {
  getAgentRunRow as defaultGetAgentRunRow,
  getProjectById as defaultGetProjectById,
  hasPendingAskForRun,
  type MarkAgentRunTerminalInput,
} from '@pc/db';
import { AgentRunJsonlTailer, jsonlPathFor, type AgentRunJsonlEvent } from '@pc/runtime';
import { ContractService } from '@pc/app-services';
import type { Contract, Deliverable } from '@pc/contracts';

import {
  buildAgentCompletedBody,
  buildAgentFailedBody,
  type VerificationBlock,
} from './agent-event-header.ts';
import type { ActiveRunRegistry } from './agent-active-runs.ts';
import { deliverAgentEnvelope, type MailboxEnqueuePort } from './agent-delivery.ts';
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
  /** Slice 013 — the first-class contract this run produced. The captured
   *  deliverable lands here (not borrowed from `wi.body`). NULL = non-contract
   *  dispatch. */
  contractId?: ULID | null;
  slug?: string | null;
  cleanup?: () => void;
}

export interface AgentRunTerminalEffectsDeps {
  activeRunRegistry?: ActiveRunRegistry;
  /** Slice 013 — first-class contract write door. When supplied + the dispatch
   *  carried a `contractId`, the captured deliverable is written onto the
   *  contract on completion. Omitting it skips the contract write (legacy-only
   *  unit tests). */
  contractService?: ContractService;
  /** Mailbox enqueue port. The terminal envelope is delivered through it; when
   *  omitted (e.g. a bare unit test) the envelope is skipped. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  broadcast?: (projectId: ULID, msg: unknown) => void;
  getAgentRun?: (id: ULID) => AgentRunRow | null;
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
  // for the correct rev. Slice 015b — the live-relay drains that outbox row and
  // fans the canonical frame; the legacy `agent-run-changed` hand-broadcast is
  // gone. When a test injects a `markTerminal` override (no real DB, no outbox),
  // just do the direct write so the gateway's getDb() path is never touched.
  if (deps.markTerminal) {
    deps.markTerminal({
      id: input.runId,
      status: input.status,
      result: input.status === 'completed' ? input.result ?? '' : null,
      failureCause,
      failureReason,
      completedAt,
    });
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

  // Slice 013 — capture the deliverable onto the contract SYNCHRONOUSLY (a
  // durable fact, like the terminal row write above). Returns the resolved
  // result text the envelope surfaces (result, else the wi.body fallback —
  // same bytes the old live wi.body surface produced, now sourced from the
  // captured deliverable). Done here (not the async tail) so the contract row
  // lands deterministically.
  const resolvedResult = captureDeliverable(input, row, deps);

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
    resolvedResult,
    deps,
  }).catch((err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    deps.onError?.(error);
  });

  return { applied: 1 };
}

/** Slice 020 — resolve the captured deliverable + return the result text the
 *  terminal envelope surfaces. SUBMISSION is the source of truth: if the agent
 *  called `pc_submit_deliverable` (slice 014b), the contract already carries its
 *  typed deliverable + report — we do NOT overwrite it. When the agent submitted
 *  NOTHING we synthesize an `answer` deliverable from the free-text `result`
 *  (the `wi.body` fallback is retired — the deliverable has a contract home). */
function captureDeliverable(
  input: AgentRunTerminalEffectsInput,
  row: AgentRunRow,
  deps: AgentRunTerminalEffectsDeps,
): string {
  const result = input.result ?? '';
  if (input.status !== 'completed') return result;

  const service = deps.contractService ?? new ContractService();
  const contractId = input.contractId ?? row.contractId ?? null;
  if (!contractId) return result;

  // Submission-gated path: a deliverable submitted via pc_submit_deliverable is
  // authoritative — keep it. Surface its text in the envelope when the agent
  // left no free-text result.
  let existing: Contract | null = null;
  try {
    existing = service.get(contractId);
  } catch {
    existing = null;
  }
  if (existing?.deliverable) {
    if (result.trim() === '') {
      const submittedText =
        existing.deliverable.kind === 'answer' || existing.deliverable.kind === 'prose'
          ? existing.deliverable.text ?? ''
          : existing.report ?? '';
      if (submittedText.trim()) return submittedText;
    }
    return result;
  }

  // Legacy fallback (no submission): the agent's free-text `result` IS the
  // `answer` deliverable. No WI-body borrow.
  const deliverableText = result.trim();
  if (deliverableText) {
    const deliverable: Deliverable = { kind: 'answer', text: deliverableText };
    try {
      service.setDeliverable({ id: contractId, deliverable, report: result || null });
    } catch (err) {
      deps.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return result;
}

/** Slice 014b — strip the MCP server prefix (`mcp__pc-rig__pc_ask_user` →
 *  `pc_ask_user`) so the `tool_called` predicate can match on the bare tool
 *  name the orchestrator authored. Non-MCP tool names (Read/Bash/...) pass
 *  through unchanged. */
function bareToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const parts = name.split('__');
  return parts.length >= 3 ? parts[parts.length - 1]! : name;
}

/** Slice 014b — production verification evidence loaders. `loadToolCalls` reads
 *  the producing run's CC transcript (the same `AgentRunJsonlTailer` the events
 *  route uses) and surfaces both prefixed + bare tool names so a `tool_called`
 *  predicate matches whether the orchestrator wrote `pc_ask_user` or the full
 *  `mcp__pc-rig__pc_ask_user`. `loadPendingAskCreated` reads the DB (any-status
 *  pending-ask for the run). Injected in production; tests pass their own. */
function buildProductionVerificationDeps(projectFolderPath: string): VerificationDeps {
  return {
    loadToolCalls: async (input) => {
      if (!input.ccSessionId) return [];
      try {
        const jsonlPath = jsonlPathFor(projectFolderPath, input.ccSessionId);
        const tailer = new AgentRunJsonlTailer({ filePath: jsonlPath, pollIntervalMs: 60_000 });
        const names: { name: string }[] = [];
        tailer.on('event', (event: AgentRunJsonlEvent) => {
          if (event.kind === 'jsonl-tool-call' && event.name) {
            names.push({ name: event.name });
            const bare = bareToolName(event.name);
            if (bare !== event.name) names.push({ name: bare });
          }
        });
        tailer.drainAvailable();
        return names;
      } catch {
        return [];
      }
    },
    loadPendingAskCreated: async (input) => {
      if (!input.runId) return false;
      try {
        return hasPendingAskForRun(input.runId);
      } catch {
        return false;
      }
    },
  };
}

async function finishTerminalEffects(args: {
  input: AgentRunTerminalEffectsInput;
  row: AgentRunRow;
  completedAt: number;
  failureCause: AgentRunFailureCause | null;
  failureReason: string | null;
  /** Slice 013 — the deliverable text resolved synchronously by
   *  `captureDeliverable` (result, else the wi.body fallback). The envelope
   *  surfaces this. */
  resolvedResult: string;
  deps: AgentRunTerminalEffectsDeps;
}): Promise<void> {
  const { input, row, failureCause, failureReason, resolvedResult, deps } = args;
  const project = safeGetProject(input.projectId);
  const contractId = input.contractId ?? row.contractId ?? null;
  const workItemId = input.workItemId !== undefined ? input.workItemId : row.parentWorkItemId;

  const verifier = deps.verifyOnTerminal ?? runVerificationOnTerminal;
  let outcome: VerificationOutcome | null = null;
  // Slice 020 — verification keys on the CONTRACT, not the WI. A contract-only
  // dispatch (no linked WI) still verifies; the WI advance is a roll-up.
  if (contractId && project) {
    outcome = await verifier(
      {
        contractId,
        workItemId,
        terminalStatus: input.status,
        failureReason,
        projectFolderPath: project.folderPath,
        worktreeDir: input.worktreeDir,
        // Slice 014a — carry the run + session so the tool-call loader can read
        // the producing run's transcript (powers `tool_called`).
        runId: input.runId,
        ccSessionId: input.ccSessionId,
        project,
      },
      // Slice 014b — wire the PRODUCTION evidence loaders when no test deps are
      // injected: `loadToolCalls` reads the producing run's CC transcript;
      // `loadPendingAskCreated` reads the DB. `executorsFor` stays on the
      // verifier's `createWorktreeExecutors` default. These power `tool_called`
      // / `pending_ask_created` for `action`-kind contracts.
      deps.verificationDeps ?? buildProductionVerificationDeps(project.folderPath),
    );
  }

  const verification: VerificationBlock | null = outcome
    ? {
        contractId: outcome.contractId,
        workItemId: outcome.workItemId,
        status: outcome.verificationStatus,
        tier: outcome.verificationTier,
        notes: outcome.notes,
      }
    : null;

  // Slice 013 — the deliverable was captured onto the contract synchronously
  // (see `captureDeliverable`). The envelope surfaces the resolved result.
  const result = resolvedResult;

  // Slice 005 — the rail broadcast (durable agent.run.changed) is emitted
  // SYNCHRONOUSLY by applyAgentRunTerminalEffects through the gateway; this
  // async tail keeps ONLY verification + the Channel terminal envelope.
  const slug = input.slug ?? project?.slug ?? null;
  if (deps.mailboxEnqueue && slug) {
    emitTerminalEnvelope({
      mailboxEnqueue: deps.mailboxEnqueue,
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

interface EmitTerminalArgs {
  mailboxEnqueue: MailboxEnqueuePort;
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
    { mailboxEnqueue: args.mailboxEnqueue },
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
