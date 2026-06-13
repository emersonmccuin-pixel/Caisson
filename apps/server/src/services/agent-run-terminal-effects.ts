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
  getMailboxMessageByIdempotencyKey as defaultGetMailboxMessageByIdempotencyKey,
  getProjectById as defaultGetProjectById,
  getWorkItem,
  hasPendingAskForRun,
  listRecentTerminalAgentRuns as defaultListRecentTerminalAgentRuns,
  newId,
  type MarkAgentRunTerminalInput,
} from '@pc/db';
import { AgentRunJsonlTailer, jsonlPathFor, type AgentRunJsonlEvent } from '@pc/runtime';
import { ContractService } from '@pc/app-services';
import {
  buildDecisionContract,
  contractDeliverableText,
  decisionContractHeaderText,
  makeReviewPackage,
  type Contract,
  type Deliverable,
} from '@pc/contracts';

import {
  buildAgentCompletedBody,
  buildAgentFailedBody,
  type VerificationBlock,
} from './agent-event-header.ts';
import type { ActiveRunRegistry } from './agent-active-runs.ts';
import { deliverAgentEnvelope, type MailboxEnqueuePort } from './agent-delivery.ts';
import { commitAgentRunTerminal } from './agent-run-writer.ts';
import { gateTerminalForDeliverable } from './agent-run-settle.ts';
import {
  runVerificationOnTerminal,
  type VerificationDeps,
  type VerificationOutcome,
} from './agent-verification.ts';
import { landAcceptedContract as defaultLandAcceptedContract } from './landing-service.ts';

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

/** Door-unification (one-agent-dispatch-door) — the post-verification terminal
 *  facts surfaced to a caller that needs to AWAIT the run (the workflow engine).
 *  The orchestrator dispatches fire-and-forget and ignores this; the workflow
 *  maps it to a DAG NodeOutcome (`failed` when status≠completed OR verification
 *  failed). Fired exactly once per run after verification has flipped the
 *  contract. */
export interface TerminalSettlement {
  status: TerminalStatus;
  failureCause: AgentRunFailureCause | null;
  failureReason: string | null;
  result: string;
  /** The contract's verification result, when the run had a contract + the
   *  verifier ran. NULL for non-contract dispatches or a cancelled run. */
  verification: VerificationBlock | null;
}

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
  /** pc-pty-chat-415 (R5) — accept ⇒ land. Called after auto-verification
   *  PASSES a contract; standalone repo contracts land on the integration
   *  branch (workflow-owned runs are skipped inside — the merge node owns
   *  them). Test seam; production defaults to the real landing service. */
  landAcceptedContract?: typeof defaultLandAcceptedContract;
  now?: () => number;
  onError?: (error: Error) => void;
  /** Issue 3 (near-term) — called immediately after the terminal mailbox
   *  envelope is enqueued so the caller can trigger an immediate worker drain
   *  instead of waiting for the next 1s poll tick. Fire-and-forget; errors are
   *  silently ignored (the tick is the correctness backstop). */
  onMailboxEnqueued?: () => void;
}

export interface AgentRunTerminalEffectsResult {
  applied: number;
}

export function applyAgentRunTerminalEffects(
  input: AgentRunTerminalEffectsInput,
  deps: AgentRunTerminalEffectsDeps = {},
): AgentRunTerminalEffectsResult {
  const row = (deps.getAgentRun ?? defaultGetAgentRunRow)(input.runId);
  if (!row || isDbTerminal(row.status)) {
    // Already terminal (reconcile re-entrancy, or the rival listener won the
    // race). Effects don't re-apply, but an awaiting caller (workflow `done`)
    // must still settle — fire the run-keyed waiter from the durable row so the
    // promise never hangs, regardless of which path finalized the row. The
    // waiter is idempotent (fires once). No re-verify (side-effecting).
    if (row) {
      deps.activeRunRegistry?.settle(input.runId, {
        status: row.status as TerminalStatus,
        failureCause: row.failureCause ?? null,
        failureReason: row.failureReason ?? null,
        result: row.result ?? '',
        verification: null,
      });
    }
    return { applied: 0 };
  }

  // Workflow-engine redesign — the completion gate. A contract-first run that
  // reaches `completed` with nothing delivered is rewritten to a typed
  // `no-deliverable` failure BEFORE any downstream effect (row commit, verify,
  // envelope, onSettled) sees it. Delivery is the sole done-signal; no-contract
  // / legacy runs are exempt (gate passes them through unchanged).
  const gated = gateTerminalForDeliverable(
    { status: input.status, failureCause: null, failureReason: input.failureReason ?? null },
    row,
    { ...(deps.contractService ? { contractService: deps.contractService } : {}) },
  );
  if (gated.downgraded) {
    input = {
      ...input,
      status: gated.status,
      failureCause: gated.failureCause,
      failureReason: gated.failureReason,
    };
  }

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

  // Slice 013/3 — capture the deliverable onto the contract SYNCHRONOUSLY (a
  // durable fact, like the terminal row write above). Returns the authoritative
  // deliverable text the envelope headlines, plus the demoted incidental note
  // (the raw turn result, carried only when a submitted deliverable is present
  // and its text differs). Done here (not the async tail) so the contract row
  // lands deterministically.
  const { deliverableText, incidentalNote } = captureDeliverable(input, row, deps);

  try {
    input.cleanup?.();
  } catch {
    /* best-effort */
  }

  // Slice 7 (pc-pty-chat-374.5) — ordering note: the deliverable capture above
  // is SYNCHRONOUS and complete before this async tail fires. The verifier
  // inside `finishTerminalEffects` enforces the write-flush barrier for
  // worktree dispatches: it checks that the agent's working tree is committed
  // before running side-effecting predicates (bash_exit_zero / files_exist).
  // Any uncommitted state visible to the barrier at this point reflects the
  // agent's work, not a server-side timing race.
  void finishTerminalEffects({
    input,
    row,
    completedAt,
    failureCause,
    failureReason,
    resolvedResult: deliverableText,
    incidentalNote,
    deps,
  }).catch((err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    deps.onError?.(error);
  });

  return { applied: 1 };
}

interface CapturedDeliverable {
  /** The authoritative result text the envelope's Result: section surfaces. */
  deliverableText: string;
  /** The incidental free-text turn result, demoted to a secondary Note: when a
   *  submitted deliverable is present and its text differs. Null otherwise. */
  incidentalNote: string | null;
}

/** Slice 020/3 — resolve the captured deliverable + return the result text the
 *  terminal envelope surfaces. SUBMISSION is the source of truth: if the agent
 *  called `pc_submit_deliverable` (slice 014b), the contract already carries its
 *  typed deliverable + report — the typed output is ALWAYS the headline. The
 *  free-text turn `result` is demoted to a secondary Note: when distinct.
 *  When the agent submitted NOTHING we synthesize an `answer` deliverable from
 *  the free-text `result` (the `wi.body` fallback is retired). */
function captureDeliverable(
  input: AgentRunTerminalEffectsInput,
  row: AgentRunRow,
  deps: AgentRunTerminalEffectsDeps,
): CapturedDeliverable {
  const result = input.result ?? '';
  if (input.status !== 'completed') return { deliverableText: result, incidentalNote: null };

  const service = deps.contractService ?? new ContractService();
  const contractId = input.contractId ?? row.contractId ?? null;
  if (!contractId) return { deliverableText: result, incidentalNote: null };

  // Submission-gated path: a deliverable submitted via pc_submit_deliverable is
  // the authoritative output. Its text is ALWAYS the Result: headline — the
  // free-text turn result is demoted to a secondary Note: when present and
  // distinct (fixing the shadow: pre-fix, a non-empty `result` overwrote the
  // submitted deliverable in the envelope).
  let existing: Contract | null = null;
  try {
    existing = service.get(contractId);
  } catch {
    existing = null;
  }
  if (existing?.deliverable) {
    const submittedText = contractDeliverableText(existing.deliverable, existing.report);
    // Fall back to `result` only when the deliverable carries no readable text
    // (e.g. a `repo` kind with no report field).
    const deliverableText = submittedText.trim() ? submittedText : result;
    // Demote the free-text turn result to a secondary note when it is present
    // and distinct from the deliverable text.
    const resultTrimmed = result.trim();
    const incidentalNote =
      resultTrimmed && resultTrimmed !== deliverableText.trim() ? result : null;
    return { deliverableText, incidentalNote };
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
  return { deliverableText: result, incidentalNote: null };
}

/** Slice 014b — strip the MCP server prefix (`mcp__pc-rig__pc_ask_orchestrator`
 *  → `pc_ask_orchestrator`) so the `tool_called` predicate can match on the
 *  bare tool name the orchestrator authored. Non-MCP tool names (Read/Bash/...)
 *  pass through unchanged. */
function bareToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const parts = name.split('__');
  return parts.length >= 3 ? parts[parts.length - 1]! : name;
}

/** Slice 014b — production verification evidence loaders. `loadToolCalls` reads
 *  the producing run's CC transcript (the same `AgentRunJsonlTailer` the events
 *  route uses) and surfaces both prefixed + bare tool names so a `tool_called`
 *  predicate matches whether the orchestrator wrote `pc_ask_orchestrator` or
 *  the full `mcp__pc-rig__pc_ask_orchestrator`. `loadPendingAskCreated` reads the DB (any-status
 *  pending-ask for the run). Injected in production; tests pass their own.
 *  `worktreeDir` is the agent's spawn cwd (determines CC's projects/ key);
 *  falls back to `projectFolderPath` for legacy runs. */
function buildProductionVerificationDeps(projectFolderPath: string, worktreeDir?: string): VerificationDeps {
  const jsonlCwd = worktreeDir ?? projectFolderPath;
  return {
    loadToolCalls: async (input) => {
      if (!input.ccSessionId) return [];
      try {
        const jsonlPath = jsonlPathFor(jsonlCwd, input.ccSessionId);
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
  /** Slice 013/3 — the authoritative deliverable text (from the submitted
   *  deliverable when present; the free-text result otherwise). The envelope
   *  Result: section surfaces this. */
  resolvedResult: string;
  /** Slice 3 — the incidental free-text turn result, carried only when a
   *  submitted deliverable is present and its text differs. Rendered as a
   *  secondary Note: in the envelope. */
  incidentalNote: string | null;
  deps: AgentRunTerminalEffectsDeps;
}): Promise<void> {
  const { input, row, failureCause, failureReason, resolvedResult, incidentalNote, deps } = args;
  const project = safeGetProject(input.projectId);
  const contractId = input.contractId ?? row.contractId ?? null;
  const workItemId = input.workItemId !== undefined ? input.workItemId : row.parentWorkItemId;

  const verifier = deps.verifyOnTerminal ?? runVerificationOnTerminal;
  let outcome: VerificationOutcome | null = null;
  let verifierCrash: Error | null = null;
  // Slice 020 — verification keys on the CONTRACT, not the WI. A contract-only
  // dispatch (no linked WI) still verifies; the WI advance is a roll-up.
  // Door-unification — guard the verifier so a verify crash doesn't skip the
  // `onSettled`/envelope tail below (the awaiting workflow `done` must settle).
  if (contractId && project) {
    try {
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
        deps.verificationDeps ?? buildProductionVerificationDeps(project.folderPath, input.worktreeDir || undefined),
      );
    } catch (err) {
      verifierCrash = err instanceof Error ? err : new Error(String(err));
      deps.onError?.(verifierCrash);
    }
  }

  // Positive receipt: a verifier CRASH is not the same as "no verification".
  // Surface it on the envelope (contract stays `pending` in the DB) instead of
  // silently reporting the run as if acceptance criteria never existed.
  const verification: VerificationBlock | null = outcome
    ? {
        contractId: outcome.contractId,
        workItemId: outcome.workItemId,
        status: outcome.verificationStatus,
        tier: outcome.verificationTier,
        notes: outcome.notes,
      }
    : verifierCrash && contractId
      ? {
          contractId,
          workItemId: workItemId ?? null,
          status: 'pending',
          tier: 'auto',
          notes: `verifier crashed before evaluating acceptance criteria: ${verifierCrash.message}`,
        }
      : null;

  // pc-pty-chat-415 (R5) — accept ⇒ land. An auto-verification PASS on a
  // standalone repo contract lands the sealed branch on the integration
  // branch through the ONE landing path. Outcome (landed / conflict / failed)
  // is durable on the contract; the note rides the verification block so the
  // settle + envelope surface where the work went. Guarded: a landing crash
  // must never starve the settle/envelope tail.
  if (outcome?.verificationStatus === 'passed' && contractId && verification) {
    try {
      const land = await (deps.landAcceptedContract ?? defaultLandAcceptedContract)(contractId);
      if (land.applicable) {
        const note =
          land.outcome === 'landed'
            ? `landed on ${land.into ?? 'the integration branch'} (branch ${land.branch})`
            : `landing ${land.outcome}: ${land.error ?? 'see contract landing record'}`;
        verification.notes = verification.notes ? `${verification.notes}\n${note}` : note;
      }
    } catch (err) {
      deps.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Slice 013 — the deliverable was captured onto the contract synchronously
  // (see `captureDeliverable`). The envelope surfaces the resolved result.
  const result = resolvedResult;

  // One terminal authority — settle the awaiting caller (workflow `done`) by
  // run id, with the post-verification terminal facts. Fired before the envelope
  // emit so a mailbox failure can't starve the workflow of its node outcome.
  // Run-keyed (not a per-call callback): done-resolution is NOT gated on which
  // host-event listener / reconcile sweep processed the terminal.
  deps.activeRunRegistry?.settle(input.runId, {
    status: input.status,
    failureCause,
    failureReason,
    result,
    verification,
  });

  // M8 (FD-7) — a contract parked at the HUMAN-review tier gets a durable
  // user-inbox card (the "Human Review inbox" the orchestrator prompt promised
  // — pre-M8 it didn't exist). Approve/reject ride the existing work-item
  // verification doors; the decision actions this card via resolve-by-source.
  // orchestrator-review stays envelope-only (the orchestrator's to handle).
  // Guarded: the inbox card is auxiliary — a crash here (work-item read,
  // package build, mailbox write) must not starve the orchestrator of the
  // terminal envelope below.
  try {
  if (
    deps.mailboxEnqueue &&
    contractId &&
    outcome &&
    outcome.verificationStatus === 'pending' &&
    outcome.verificationTier === 'human-review'
  ) {
    const agentName = input.slug ?? input.podName ?? 'agent';
    const workItemTitle = outcome.workItemId
      ? (getWorkItem(outcome.workItemId)?.title ?? null)
      : null;
    // Phase 1.1 — build the unified ReviewPackage envelope (additive: carried
    // alongside the existing payload fields, existing consumers unchanged).
    // pc-pty-chat-221 — attach the decision-contract header so every review
    // surface knows what it is deciding without relying on author prompt discipline.
    const verificationTitle = workItemTitle
      ? `Review needed: ${agentName} — ${workItemTitle}`
      : `Review needed: ${agentName} finished its work`;
    const decisionContract = buildDecisionContract({ lifecyclePosition: 'completed-work' });
    const headerText = decisionContractHeaderText(decisionContract);
    const verificationBody =
      headerText + '\n\n' +
      `Agent ${agentName} handed in its work; the contract is waiting on YOUR review.\n` +
      (outcome.workItemId ? `Card: ${outcome.workItemId}\n` : '') +
      `Approve to accept the work (the card advances); reject with feedback to send it back.`;
    const reviewPackage = makeReviewPackage({
      id: newId(),
      producer: 'agent-verification',
      owner: 'human',
      title: verificationTitle,
      whatWasAsked: workItemTitle ? `Review ${workItemTitle}` : `Review ${agentName}'s completed work`,
      acceptanceCriteria: '',
      work: { kind: 'prose', text: verificationBody },
      provenance: {
        agentRunId: input.runId,
        workItemId: outcome.workItemId ?? null,
        workflowNodeId: null,
        dispatchedAt: Date.now(),
      },
      decisionContract,
    });
    deps.mailboxEnqueue({
      message: {
        id: newId(),
        projectId: input.projectId,
        kind: 'verification-review',
        subject: verificationTitle,
        body: verificationBody,
        payload: {
          contractId,
          workItemId: outcome.workItemId,
          workItemTitle,
          runId: input.runId,
          agent: agentName,
          // Phase 1.1 — unified ReviewPackage envelope (additive).
          reviewPackage,
        },
        sourceKind: 'agent-contract',
        sourceId: contractId,
        idempotencyKey: `verification-review:${contractId}`,
      },
      recipients: [
        {
          id: newId(),
          addressKind: 'user-inbox',
          addressJson: { kind: 'user-inbox', userId: 'local-user', projectId: input.projectId },
          channel: 'ui-inbox',
          deliveryId: newId(),
        },
      ],
      now: Date.now(),
    });
  }
  } catch (err) {
    deps.onError?.(err instanceof Error ? err : new Error(String(err)));
  }

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
      note: incidentalNote,
      failureCause,
      verification,
    });
    // Issue 3 (near-term) — signal the mailbox worker to drain immediately so
    // the terminal envelope reaches the orchestrator within ms, not at the next
    // 1s poll tick. The 1s tick + S3 replay are the durable backstops; this is
    // a latency optimisation only. Errors are silently swallowed (no throw in
    // an async detached tail).
    try { deps.onMailboxEnqueued?.(); } catch { /* intentional */ }
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
  /** Slice 3 — incidental free-text turn result, demoted to a secondary Note:
   *  in the completed envelope when present and distinct from the deliverable.
   *  Optional so the replay path (which reads the DB row) does not need to
   *  change. */
  note?: string | null;
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
          note: args.note,
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

// ─────────────────────────── S3 envelope replay ──────────────────────────────

export interface ReplayMissingEnvelopesDeps {
  mailboxEnqueue?: MailboxEnqueuePort | null;
  /** Recent-terminal feeder. Defaults to the @pc/db window query. */
  listRecentTerminalRuns?: (since: number) => AgentRunRow[];
  /** Idempotency-key probe. Defaults to the @pc/db mailbox read. */
  hasMailboxKey?: (key: string) => boolean;
  /** Read door for the producing contract's STORED verification state. Replay
   *  never RE-RUNS verification (that has side effects — accept/advance); it
   *  reads what the contract already carries. Defaults to ContractService. */
  contractService?: ContractService;
  /** How far back to scan. Default 6h — comfortably past any tail-throw window
   *  without growing into a full-table sweep. */
  windowMs?: number;
  now?: () => number;
  onError?: (error: Error) => void;
}

export interface ReplayMissingEnvelopesResult {
  scanned: number;
  replayed: number;
}

/**
 * S3 safety net — guarantees the orchestrator is eventually notified of a
 * terminal run EXACTLY ONCE even when the detached notify tail
 * (`finishTerminalEffects`) threw before enqueuing the agent-completed/failed
 * envelope (verification crash, mailbox write error). The terminal row + UI fact
 * commit synchronously and durably; only the orchestrator envelope rode the
 * fire-and-forget tail. This pass re-derives that envelope from the durable row.
 *
 * Separate from `applyAgentRunTerminalEffects` ON PURPOSE: that function
 * short-circuits on already-terminal rows (`:89`), which would block replay.
 * This is reachable for terminal rows.
 *
 * EXACTLY-ONCE: the mailbox enqueue is idempotent on `agent:${runId}:${kind}`.
 * We probe for that key first and only emit when absent — and even a lost race
 * (two passes emit at once) collapses to one row at the repo's idempotency
 * guard. A successfully-notified run is skipped on every subsequent pass.
 */
export async function replayMissingTerminalEnvelopes(
  deps: ReplayMissingEnvelopesDeps = {},
): Promise<ReplayMissingEnvelopesResult> {
  const enqueue = deps.mailboxEnqueue;
  if (!enqueue) return { scanned: 0, replayed: 0 };

  const now = (deps.now ?? Date.now)();
  const windowMs = deps.windowMs ?? 6 * 60 * 60 * 1000;
  const rows = (deps.listRecentTerminalRuns ?? defaultListRecentTerminalAgentRuns)(now - windowMs);
  const hasKey =
    deps.hasMailboxKey ??
    ((key) => defaultGetMailboxMessageByIdempotencyKey(key) !== null);

  let replayed = 0;
  for (const row of rows) {
    const status = row.status as TerminalStatus;
    // Spawn-flakiness fix (2026-06-10) — a dispatch that failed BEFORE any
    // spawn on a host start receipt already returned that failure
    // SYNCHRONOUSLY to its dispatcher (the pc_invoke_agent tool result / the
    // workflow settlement). Replaying an agent-failed envelope for it minutes
    // later re-pages the orchestrator about a failure it has typically already
    // retried — pure noise. The sync receipt is the notification; skip.
    if (
      status === 'failed' &&
      row.spawnedAt === null &&
      (row.failureCause === 'host-unavailable' ||
        row.failureCause === 'host-rejected' ||
        row.failureCause === 'host-protocol-error')
    ) {
      continue;
    }
    const kind: AgentInboxEventKind =
      status === 'completed' ? 'agent-completed' : 'agent-failed';
    if (hasKey(`agent:${row.id}:${kind}`)) continue;

    const project = safeGetProject(row.projectId);
    const slug = project?.slug ?? null;
    if (!slug) continue; // no recipient address derivable — leave for next pass

    // Enrichment from the contract's STORED verification (no re-verify — that
    // accepts/advances and would double-apply). A base envelope still notifies.
    const verification = storedVerificationFor(row, deps);

    try {
      emitTerminalEnvelope({
        mailboxEnqueue: enqueue,
        projectId: row.projectId,
        dispatcherSessionId: row.dispatcherSessionId,
        slug,
        runId: row.id,
        ccSessionId: row.ccSessionId,
        podName: row.podName,
        parentWorkItemId: row.parentWorkItemId,
        terminalStatus: status,
        result: row.result ?? '',
        failureCause: row.failureCause,
        verification,
      });
      replayed += 1;
    } catch (err) {
      deps.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return { scanned: rows.length, replayed };
}

/** Read the producing contract's STORED verification state for the replay
 *  envelope. Never re-runs the verifier (which accepts/advances — side effects
 *  that would double-apply). Returns null when there's no contract or no stored
 *  status yet; the base envelope still notifies. */
function storedVerificationFor(
  row: AgentRunRow,
  deps: ReplayMissingEnvelopesDeps,
): VerificationBlock | null {
  const contractId = row.contractId ?? null;
  if (!contractId) return null;
  try {
    const service = deps.contractService ?? new ContractService();
    const contract = service.get(contractId);
    if (!contract || !contract.verificationStatus || !contract.verificationTier) return null;
    return {
      contractId,
      workItemId: contract.workItemId,
      status: contract.verificationStatus,
      tier: contract.verificationTier,
      notes: contract.verificationNotes,
    };
  } catch {
    return null;
  }
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
    case 'host-rejected':
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
    case 'host-rejected':
      return 'agent host rejected the dispatch command';
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
