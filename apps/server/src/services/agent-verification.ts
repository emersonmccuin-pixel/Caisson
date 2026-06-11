// Section 26.5 / slice 020 — contract-authoritative acceptance-criteria
// verification on AgentRun terminal.
//
// Called from `agent-run-terminal-effects.ts` after every dispatched agent's
// terminal transition. The run carries a `contractId` (slice 019 — dispatch
// always mints a contract). This pass reads tier + acceptance-criteria FROM THE
// CONTRACT, runs the predicate evaluator, and flips the CONTRACT to
// accepted / rejected / verifying via `ContractService.setVerification`.
//
// The work item moving to "done" is a ROLL-UP side effect: it fires exactly
// once, on contract-accept, and ONLY when the contract has a linked work item
// (`contract.workItemId`). A contract with no work item verifies with no WI
// side effects.
//
// Tier semantics (locked at the agent output contract § "Verification flow"):
//   - auto: predicates run; pass = accepted, fail = rejected.
//   - orchestrator-review / human-review: contract flips to `verifying`
//     (`verification_status = 'pending'`); the approve/reject tools (26.6)
//     drive the next transition.
//
// Terminal-status semantics:
//   - completed → tier-1 predicate eval (or tier-2/3 hold).
//   - failed → contract rejected immediately, no predicate eval; the agent
//     died before reporting done.
//   - cancelled → no automatic contract update; the orchestrator decided to
//     abandon this dispatch and owns the next step.
//
// Predicate execution is sandboxed: `fileSize` rejects relative paths that
// escape the worktree; `runBash` applies a per-predicate timeout (from
// `bash_exit_zero.timeout_ms`) falling back to `DEFAULT_BASH_TIMEOUT_MS`
// when none is set. Repo checks derived by `ac-derivation` carry a 10-minute
// default (pc-pty-chat-370) so pnpm typecheck / pnpm test aren't SIGKILLed
// mid-run. Ad-hoc script predicates with no timeout_ms keep the 30s default.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';

import {
  applyRunOutcome,
  getWorkItem,
  listAttachmentsForWorkItem,
  listChildWorkItems,
} from '@pc/db';
import type { Contract } from '@pc/contracts';
import { ContractService, WorkItemMutationGateway } from '@pc/app-services';
import type {
  EvaluationContext,
  PredicateExecutors,
  Project,
  ULID,
  VerificationStatus,
  VerificationTier,
} from '@pc/domain';
import {
  ContractV2,
  KINDS_REQUIRING_EVIDENCE,
  evaluateAcceptance,
  decideContractCompletion,
  planRollUp,
} from '@pc/domain';

import { autoAdvanceToDoneStage } from './auto-advance-done.ts';

/** FD-12 — the one write door (repo write + outbox receipt in one txn). */
const gateway = new WorkItemMutationGateway();

/** Fallback cap on a single `bash_exit_zero` predicate when the predicate
 *  carries no `timeout_ms` field. Keeps the terminal handler from blocking on
 *  a runaway ad-hoc script. Repo checks derived by `ac-derivation` carry
 *  their own 10-minute timeout_ms (pc-pty-chat-370) and never hit this. */
const DEFAULT_BASH_TIMEOUT_MS = 30_000;

export interface RunVerificationInput {
  /** The first-class contract this run produced (slice 019 — always present on
   *  a dispatched run). Null = no contract; verification is a no-op. */
  contractId: ULID | null;
  /** Optional work-item link carried on the contract. When the contract is
   *  accepted AND this is set, the WI-advance roll-up fires. */
  workItemId?: ULID | null;
  terminalStatus: 'completed' | 'failed' | 'cancelled';
  /** Human-readable failure summary when `terminalStatus === 'failed'`. Used
   *  as the contract's verification notes. */
  failureReason: string | null;
  /** Project root absolute path. Used as `cwd` for predicates declaring
   *  `cwd: 'project'`. */
  projectFolderPath: string;
  /** Agent's worktree absolute path. Default `cwd` for `bash_exit_zero` +
   *  the resolution root for `files_exist` relative paths. */
  worktreeDir: string;
  /** Slice 014a — the producing run + its CC session. The tool-call loader
   *  reads the run's transcript via the session id; optional so legacy callers
   *  + tests can omit them (the loaders then yield empty evidence). */
  runId?: ULID;
  ccSessionId?: string;
  /** Section 27.7 — full project record. When provided + verification PASS
   *  resolves + the project has an `is_done` stage AND a linked WI exists, the
   *  WI auto-advances there after the roll-up status flip. `null` skips
   *  auto-advance (test paths that don't care about stage motion). */
  project?: Project | null;
}

export interface VerificationOutcome {
  /** The verified contract. */
  contractId: ULID;
  /** The contract's linked work item, when one exists (the roll-up target). */
  workItemId: ULID | null;
  verificationStatus: VerificationStatus;
  verificationTier: VerificationTier;
  /** Human-readable summary suitable for the channel-event tag. `null` when
   *  the contract flipped to a non-failure state with no diagnostic to surface. */
  notes: string | null;
  /** Number of predicates that were evaluated. Zero for tier-2/3 holds + for
   *  the failed-agent path (predicates skipped). */
  predicatesEvaluated: number;
}

export interface VerificationDeps {
  /** Inject the predicate executors for tests. Production constructs a
   *  worktree-bound impl via `createWorktreeExecutors`. */
  executorsFor?: (input: RunVerificationInput) => PredicateExecutors;
  /** Slice 014a — load the producing run's tool-call names from its session
   *  transcript (powers `tool_called`). Injected; production reads the session
   *  checkpoint via `loadSessionReplayCheckpoint`. Omitted ⇒ no tool evidence. */
  loadToolCalls?: (input: RunVerificationInput) => Promise<ReadonlyArray<{ name: string }>>;
  /** Slice 014a — true when the run created a durable pending-ask (powers
   *  `pending_ask_created`). Injected; production reads the DB. */
  loadPendingAskCreated?: (input: RunVerificationInput) => Promise<boolean>;
  /** Slice 020 — the contract write door. Defaults to a fresh ContractService;
   *  injectable for tests. */
  contractService?: ContractService;
  /** Slice 7 (pc-pty-chat-374.5) — flush-barrier check for worktree dispatches.
   *  Returns true when the working tree has uncommitted changes. Injected in
   *  tests; production falls back to the private `workingTreeDirty` helper. */
  checkDirtyWorktree?: (worktreeDir: string) => Promise<boolean>;
  now?: () => number;
}

/** Run the verification pass for one terminal AgentRun. Returns null when
 *  no verification ran (no contract, missing contract, or cancelled). The
 *  terminal-envelope builder treats `null` as "no verification block." */
export async function runVerificationOnTerminal(
  input: RunVerificationInput,
  deps: VerificationDeps = {},
): Promise<VerificationOutcome | null> {
  if (!input.contractId) return null;

  const service = deps.contractService ?? new ContractService();
  let contract: Contract | null;
  try {
    contract = service.get(input.contractId);
  } catch {
    contract = null;
  }
  if (!contract) return null;

  // The contract carries the authoritative link; the caller may also pass one
  // (e.g. tests). Prefer the contract's own link.
  const workItemId = (contract.workItemId ?? input.workItemId ?? null) as ULID | null;
  const tier: VerificationTier = contract.verificationTier ?? 'auto';

  // Agent died before reporting done. No predicate eval — the contract
  // can't be satisfied if the agent never finished the deliverable the
  // criteria check against.
  if (input.terminalStatus === 'failed') {
    const notes = input.failureReason ?? 'agent run failed';
    service.setVerification({
      id: input.contractId,
      verificationStatus: 'failed',
      verificationNotes: notes,
      verificationTier: tier,
    });
    return {
      contractId: input.contractId,
      workItemId,
      verificationStatus: 'failed',
      verificationTier: tier,
      notes,
      predicatesEvaluated: 0,
    };
  }

  // Cancelled by the orchestrator or user. The dispatch was abandoned on
  // purpose; don't auto-flip the contract — the caller owns the next move.
  if (input.terminalStatus === 'cancelled') return null;

  // Tier-2 / tier-3 hold. Approve/reject tools (26.6) drive the next
  // transition. Park the contract in `verifying` with `pending`.
  if (tier === 'orchestrator-review' || tier === 'human-review') {
    service.setVerification({
      id: input.contractId,
      verificationStatus: 'pending',
      verificationNotes: null,
      verificationTier: tier,
    });
    return {
      contractId: input.contractId,
      workItemId,
      verificationStatus: 'pending',
      verificationTier: tier,
      notes: null,
      predicatesEvaluated: 0,
    };
  }

  // Tier-1 auto. AC sourced from the contract ONLY (dual-read shim retired).
  const criteria = contract.acceptanceCriteria ?? [];

  // Slice 014a — fail-closed. An evidence-requiring output kind (action /
  // external / repo) that derived to ZERO predicates must NOT auto-pass: an
  // auto-verifier with nothing to check on a side-effect contract escalates to
  // review instead of passing open.
  const specObj = contract.expectedOutput as
    | { kind?: unknown; trust_end_turn?: unknown; isolation?: unknown }
    | null
    | undefined;
  const specKind = specObj?.kind;
  const requiresEvidence =
    ContractV2.isExpectedOutputKind(specKind) &&
    (KINDS_REQUIRING_EVIDENCE as readonly string[]).includes(specKind);
  // 2026-06-07 empty-contract fix — a bare `answer` (no must_address/min_chars)
  // must NOT silently auto-pass. It escalates to review unless the spec opts in
  // via `trust_end_turn` (the degenerate-answer stock pods set it). Other
  // structural kinds (prose/binary, external opt-out) keep trusting an empty set.
  const answerWithoutTrust = specKind === 'answer' && specObj?.trust_end_turn !== true;
  if (criteria.length === 0 && (requiresEvidence || answerWithoutTrust)) {
    const notes = requiresEvidence
      ? `"${specKind}" output requires evidence but no acceptance criteria were derived — escalated to review`
      : '"answer" output declared no acceptance criteria (no must_address / min_chars / trust_end_turn) — escalated to review';
    service.setVerification({
      id: input.contractId,
      verificationStatus: 'pending',
      verificationNotes: null,
      verificationTier: tier,
    });
    return {
      contractId: input.contractId,
      workItemId,
      verificationStatus: 'pending',
      verificationTier: tier,
      notes,
      predicatesEvaluated: 0,
    };
  }

  // Tier-1 auto. Empty AC = "trust the agent's end-of-turn signal" per the
  // derivation library — accept directly with no diagnostic.
  if (criteria.length === 0) {
    return acceptContract({ input, contractId: input.contractId, workItemId, tier, service, notes: null, predicatesEvaluated: 0, historyNote: 'verification passed (no predicates)' });
  }

  const attachments = workItemId ? listAttachmentsForWorkItem(workItemId) : [];
  const children = workItemId ? listChildWorkItems(workItemId) : [];
  const wi = workItemId ? getWorkItem(workItemId) : null;
  // Slice 014a — the captured deliverable (set synchronously before this runs)
  // feeds the payload/external predicates.
  const deliverable = contract.deliverable as
    | { kind?: string; data?: unknown; handle?: string; text?: string }
    | null
    | undefined;
  // pc-pty-chat-265.1 — report is the orchestrator-facing free-text note only.
  // deliverableText carries the submitted answer/prose text and is the corpus
  // that `report_contains` + `min_length` measure — NOT the report string.
  const reportText = contract.report ?? '';
  const deliverableText =
    deliverable?.kind === 'answer' || deliverable?.kind === 'prose'
      ? (deliverable.text ?? '')
      : '';
  const evalCtx: EvaluationContext = {
    body: wi?.body ?? '',
    fields: wi?.fields ?? {},
    // Section 26 carry-over #2 — surface `content` so `body_contains` can
    // search both body + attachments.
    attachments: attachments.map((a) => ({ name: a.name, content: a.content })),
    childWorkItems: children.map((c) => ({ status: c.status })),
    // Slice 014a — evidence sources for the v2 predicates.
    report: reportText,
    deliverableText,
    toolCalls: (await deps.loadToolCalls?.(input)) ?? [],
    pendingAskCreated: (await deps.loadPendingAskCreated?.(input)) ?? false,
    payload: deliverable?.kind === 'payload' ? deliverable.data : undefined,
    externalHandle: deliverable?.kind === 'external' ? deliverable.handle ?? null : undefined,
  };

  const executors = (deps.executorsFor ?? createWorktreeExecutors)(input);

  // Flush barrier (Principle 2c / pc-pty-chat-374.5): for worktree dispatches
  // with side-effecting predicates (bash_exit_zero / files_exist), the agent's
  // final file writes must be committed before these checks run. A dirty
  // working tree at verification time means the worktree is not in a stable
  // committed state — treat as inconclusive rather than running checks against
  // a half-written tree and producing a potentially wrong verdict.
  const hasSideEffectingPredicate = criteria.some(
    (p) => p.kind === 'bash_exit_zero' || p.kind === 'files_exist',
  );
  if (specObj?.isolation === 'worktree' && hasSideEffectingPredicate) {
    const isDirty = await (
      deps.checkDirtyWorktree ??
      ((dir) => workingTreeDirty(dir, DEFAULT_BASH_TIMEOUT_MS))
    )(input.worktreeDir);
    if (isDirty) {
      const notes =
        'verification inconclusive: worktree has uncommitted changes — side-effecting checks require committed state; not a work failure';
      service.setVerification({
        id: input.contractId,
        verificationStatus: 'pending',
        verificationNotes: notes,
        verificationTier: tier,
      });
      return {
        contractId: input.contractId,
        workItemId,
        verificationStatus: 'pending',
        verificationTier: tier,
        notes,
        predicatesEvaluated: 0,
      };
    }
  }

  const { pass, failures } = await evaluateAcceptance(criteria, evalCtx, executors);

  if (pass) {
    const predicateWord = criteria.length === 1 ? 'predicate' : 'predicates';
    return acceptContract({
      input,
      contractId: input.contractId,
      workItemId,
      tier,
      service,
      notes: null,
      predicatesEvaluated: criteria.length,
      historyNote: `verification passed (tier-1, ${criteria.length} ${predicateWord})`,
    });
  }

  // Inconclusive classification (Principle 2c / pc-pty-chat-374.5): when EVERY
  // failure is tagged inconclusive (exit 127 / spawn error, no captured output),
  // the executor itself misbehaved — the contract outcome is unknown, not bad.
  // Escalate to pending so the orchestrator can retry or inspect; do NOT flip to
  // failed (which means the agent's WORK failed). A mix of inconclusive and
  // genuine failures → genuine 'failed' (at least one check ran and found a
  // real problem).
  if (failures.length > 0 && failures.every((f) => f.inconclusive === true)) {
    const cmdList = failures.map((f) => f.reason).join('; ');
    const notes = `verification inconclusive: predicate executor(s) could not run — not a work failure: ${cmdList}`;
    service.setVerification({
      id: input.contractId,
      verificationStatus: 'pending',
      verificationNotes: notes,
      verificationTier: tier,
    });
    return {
      contractId: input.contractId,
      workItemId,
      verificationStatus: 'pending',
      verificationTier: tier,
      notes,
      predicatesEvaluated: criteria.length,
    };
  }

  // Tier-1 fail. Persist the per-predicate failure list as JSON; the
  // human-readable summary lives in the channel-event tag.
  const summary = failures.map((f) => `${f.kind}: ${f.reason}`).join('; ');
  service.setVerification({
    id: input.contractId,
    verificationStatus: 'failed',
    verificationNotes: JSON.stringify(failures),
    verificationTier: tier,
  });
  return {
    contractId: input.contractId,
    workItemId,
    verificationStatus: 'failed',
    verificationTier: tier,
    notes: summary,
    predicatesEvaluated: criteria.length,
  };
}

/** Accept the contract + fire the WI-advance roll-up. The roll-up flips the
 *  linked work item to `complete` + auto-advances it to the done stage — but
 *  ONLY when the contract has a linked WI. Fires exactly once (this is the sole
 *  accept path).
 *
 *  Slice 1 — Rule 1 + Rule 2 guard (Steps 9+10):
 *    - Leaf WI (no children): complete immediately (existing behavior).
 *    - Parent WI (children present): accept contract only; roll-up cascade
 *      completes the parent when all children are done.
 *    - Workflow root: exempt from roll-up — keep existing completion behavior. */
function acceptContract(args: {
  input: RunVerificationInput;
  contractId: ULID;
  workItemId: ULID | null;
  tier: VerificationTier;
  service: ContractService;
  notes: string | null;
  predicatesEvaluated: number;
  historyNote: string;
}): VerificationOutcome {
  const { input, contractId, workItemId, tier, service, notes, predicatesEvaluated, historyNote } =
    args;
  service.setVerification({
    id: contractId,
    verificationStatus: 'passed',
    verificationNotes: null,
    verificationTier: tier,
  });
  // Roll-up: the WI advance fires only for output-linked contracts. The
  // contract owns verification status/notes now; the WI roll-up only flips
  // status + appends a history note.
  // FD-12 — outcome flip + optional auto-advance + the receipt land in ONE
  // gateway transaction. Row gone mid-flight → commit nothing, emit nothing.
  const wiRow = workItemId ? getWorkItem(workItemId) : null;
  if (workItemId && wiRow) {
    // Step 9 — Rule 1 + Rule 2 guard: decide whether this contract acceptance
    // should immediately complete the WI or defer to roll-up.
    const children = listChildWorkItems(workItemId);
    const decision = decideContractCompletion({
      childCount: children.length,
      isWorkflowRoot: wiRow.isWorkflowRoot ?? false,
    });

    if (decision === 'complete') {
      // Leaf or workflow root — current behavior: flip to complete immediately.
      gateway.tryCommitWorkItemChange({
        projectId: wiRow.projectId,
        mutate: () => {
          const updated = applyRunOutcome(workItemId, 'complete', null, historyNote);
          if (!updated) return null;
          if (input.project) {
            const advanced = autoAdvanceToDoneStage(workItemId, input.project);
            if (advanced) return { row: advanced, reason: 'auto-advanced' };
          }
          return { row: updated, reason: 'verified' };
        },
      });

      // Step 10 — cascade: after the leaf completes, check if its ancestors
      // also become complete (planRollUp). Apply each roll-up in order.
      applyRollUpCascade(workItemId, historyNote, input.project ?? null);
    }
    // else 'accept-only': contract is marked passed but the WI stays open
    // until its children all complete (cascade fires from those children).
  }
  return {
    contractId,
    workItemId,
    verificationStatus: 'passed',
    verificationTier: tier,
    notes,
    predicatesEvaluated,
  };
}

/**
 * Step 10 — roll-up cascade: after completing `justCompletedId`, walk up the
 * parent chain and complete any ancestor whose children are now all done.
 * Each ancestor's completion is a separate gateway commit (each emits its own
 * `work-item.changed` live-event). Cascade continues until no more ancestors
 * qualify or a workflow root is reached.
 */
function applyRollUpCascade(
  justCompletedId: ULID,
  _historyNote: string,
  project: Project | null,
): void {
  // Snapshot helper that wraps the DB repo calls for planRollUp.
  const toRollUp = planRollUp({
    completedWorkItemId: justCompletedId,
    getParent: (id) => {
      const row = getWorkItem(id);
      if (!row) return null;
      const parent = row.parentId ? getWorkItem(row.parentId) : null;
      if (!parent) return null;
      return {
        id: parent.id,
        parentId: parent.parentId,
        isWorkflowRoot: parent.isWorkflowRoot ?? false,
        status: parent.status,
      };
    },
    getChildren: (parentId) => listChildWorkItems(parentId),
  });

  for (const ancestorId of toRollUp) {
    const ancestorRow = getWorkItem(ancestorId);
    if (!ancestorRow) continue;
    gateway.tryCommitWorkItemChange({
      projectId: ancestorRow.projectId,
      mutate: () => {
        const updated = applyRunOutcome(ancestorId, 'complete', null, 'completed by roll-up');
        if (!updated) return null;
        if (project) {
          const advanced = autoAdvanceToDoneStage(ancestorId, project);
          if (advanced) return { row: advanced, reason: 'auto-advanced' };
        }
        return { row: updated, reason: 'verified' };
      },
    });
  }
}

// ── Predicate executors ────────────────────────────────────────────────────

/** Production `PredicateExecutors` bound to a worktree + project root.
 *  `fileSize` is worktree-scoped: relative paths must resolve inside the
 *  worktree (path-guard parity with the worktree-bound bash hook). */
export function createWorktreeExecutors(input: {
  worktreeDir: string;
  projectFolderPath: string;
  bashTimeoutMs?: number;
  /** Full project record (present when called with RunVerificationInput).
   *  Carries settings.integrationBranch — the authoritative committed-diff
   *  base for worktree dispatches. Optional: project-less test paths fall
   *  back to the literal base list. */
  project?: Project | null;
}): PredicateExecutors {
  const bashTimeoutMs = input.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  return {
    async fileSize(relativePath) {
      const abs = resolve(input.worktreeDir, relativePath);
      if (!isInside(abs, input.worktreeDir)) return null;
      try {
        const st = statSync(abs);
        if (!st.isFile()) return null;
        return st.size;
      } catch {
        return null;
      }
    },
    async runBash(command, cwd, timeoutMs) {
      const cwdAbs = cwd === 'project' ? input.projectFolderPath : input.worktreeDir;
      // Per-predicate timeout (from bash_exit_zero.timeout_ms) overrides the
      // executor-level default. Repo checks carry a 10-minute timeout_ms set
      // by ac-derivation; ad-hoc predicates fall back to bashTimeoutMs (30s).
      const effectiveTimeout = timeoutMs ?? bashTimeoutMs;
      // Slice 5 (pc-pty-chat-374.4): buffer stdout + stderr so failure reasons
      // carry actual diagnostic output (Principle 2a — no verdict without evidence).
      const TAIL_CAP = 4096;
      return await new Promise<{
        exitCode: number;
        timedOut: boolean;
        stdoutTail?: string;
        stderrTail?: string;
      }>((resolveResult) => {
        let settled = false;
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        // Slice 6 (pc-pty-chat-374.6): build a deterministic, explicit env so
        // local toolchain resolves consistently regardless of how the server
        // was launched. Prepend the worktree and project-root node_modules/.bin
        // dirs to PATH so pnpm/tsc/vitest binaries installed locally are found
        // first. We start from process.env (never capture the agent's launch env
        // or any secrets) and only mutate the PATH key.
        // On Windows the PATH key may be stored as "Path" — find it case-insensitively.
        const pathKey =
          Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
        const binsToAdd = [
          join(input.worktreeDir, 'node_modules', '.bin'),
          join(input.projectFolderPath, 'node_modules', '.bin'),
        ].join(delimiter);
        const runEnv: NodeJS.ProcessEnv = {
          ...process.env,
          [pathKey]: binsToAdd + delimiter + (process.env[pathKey] ?? ''),
        };
        const child = spawn(command, { shell: true, cwd: cwdAbs, env: runEnv });
        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutChunks.push(chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrChunks.push(chunk);
        });
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            child.kill('SIGKILL');
          } catch {
            /* best-effort kill */
          }
          // timedOut:true lets the evaluator report "timed out" rather than
          // "exited 124" — the distinction matters for diagnosis (pc-pty-chat-370).
          resolveResult({ exitCode: 124, timedOut: true });
        }, effectiveTimeout);
        child.on('error', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // 127 mirrors a "command not found" exit.
          resolveResult({ exitCode: 127, timedOut: false });
        });
        child.on('exit', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const stdoutFull = Buffer.concat(stdoutChunks).toString('utf8');
          const stderrFull = Buffer.concat(stderrChunks).toString('utf8');
          const stdoutTail = tailBytes(stdoutFull, TAIL_CAP) || undefined;
          const stderrTail = tailBytes(stderrFull, TAIL_CAP) || undefined;
          resolveResult({ exitCode: code ?? 0, timedOut: false, stdoutTail, stderrTail });
        });
      });
    },
    async hasGitDiff(cwd) {
      const cwdAbs = cwd === 'project' ? input.projectFolderPath : input.worktreeDir;

      if (cwd === 'worktree') {
        // Worktree dispatches: assert COMMITTED changes vs the provisioning base.
        // The project's configured integration branch is the authoritative base;
        // the literal list is a fallback for project-less test paths. Try each
        // in order; the first that resolves determines the result. A count > 0
        // means committed changes exist — working-tree dirtiness is
        // intentionally IGNORED so a clean commit does NOT false-fail the
        // predicate (pc-pty-chat-207 / pc-pty-chat-281).
        const configured = input.project?.settings.integrationBranch;
        const bases = [...new Set([configured, 'dev', 'main', 'master', 'trunk'])].filter(
          (b): b is string => typeof b === 'string' && b.length > 0,
        );
        for (const base of bases) {
          const count = await countCommitsAhead(cwdAbs, base, bashTimeoutMs);
          if (count !== null) return count > 0;
        }
        // No known base branch found (e.g., standalone test repo). Fall through
        // to working-tree check as a last resort.
      }

      // Project (in-place) dispatches, or worktree with no detectable base:
      // fall back to checking working-tree dirtiness (original behavior).
      // Note: for in-place, a clean committed diff still false-fails — fixing
      // that requires storing the pre-dispatch HEAD at contract creation time.
      return workingTreeDirty(cwdAbs, bashTimeoutMs);
    },
  };
}

/** Returns the LAST `maxBytes` characters of `s`. Used to cap stdout/stderr
 *  diagnostic tails before embedding them in failure reasons. Returns `s`
 *  unchanged when it already fits within the cap. */
function tailBytes(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s;
  return s.slice(-maxBytes);
}

/** True iff `abs` resolves under `root` (exclusive of `root` itself). Reject
 *  exact-match + escapes. */
function isInside(abs: string, root: string): boolean {
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  return true;
}

/**
 * Count commits on the current branch in `cwd` that are NOT reachable from
 * `base`. Returns null when `base` doesn't exist or git exits non-zero.
 *
 * Used by `hasGitDiff` to detect committed changes vs the provisioning base
 * branch (e.g. `dev`, `main`, `master`) without inspecting the working tree.
 */
function countCommitsAhead(cwd: string, base: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn('git', ['rev-list', '--count', `${base}..HEAD`], { cwd });
    const finish = (val: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.on('error', () => finish(null));
    child.on('exit', (code) => {
      if (code !== 0) {
        // Base branch doesn't exist or git error — caller tries next candidate.
        finish(null);
      } else {
        const n = parseInt(out.trim(), 10);
        finish(isNaN(n) ? null : n);
      }
    });
  });
}

/**
 * True iff the working tree in `cwd` has any uncommitted change (tracked,
 * staged, or untracked). Used as the fallback for `hasGitDiff` when committed-
 * diff detection isn't applicable (in-place isolation or no detectable base).
 */
function workingTreeDirty(cwd: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn('git', ['status', '--porcelain'], { cwd });
    const finish = (val: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
      finish(false);
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.on('error', () => finish(false));
    child.on('exit', () => finish(out.trim().length > 0));
  });
}
