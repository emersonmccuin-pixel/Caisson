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
// escape the worktree; `runBash` runs with a 30s hard timeout via SIGKILL.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  applyRunOutcome,
  getWorkItem,
  listAttachmentsForWorkItem,
  listChildWorkItems,
} from '@pc/db';
import type { Contract } from '@pc/contracts';
import { ContractService } from '@pc/app-services';
import type {
  EvaluationContext,
  PredicateExecutors,
  Project,
  ULID,
  VerificationStatus,
  VerificationTier,
} from '@pc/domain';
import { ContractV2, KINDS_REQUIRING_EVIDENCE, evaluateAcceptance } from '@pc/domain';

import { autoAdvanceToDoneStage } from './auto-advance-done.ts';

/** Default cap on a single `bash_exit_zero` predicate. Keeps the terminal
 *  handler from blocking on a runaway verifier script. Override per test. */
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
  const specKind = (contract.expectedOutput as { kind?: unknown } | null | undefined)?.kind;
  const requiresEvidence =
    ContractV2.isExpectedOutputKind(specKind) &&
    (KINDS_REQUIRING_EVIDENCE as readonly string[]).includes(specKind);
  if (criteria.length === 0 && requiresEvidence) {
    const notes = `"${specKind}" output requires evidence but no acceptance criteria were derived — escalated to review`;
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
    | { kind?: string; data?: unknown; handle?: string }
    | null
    | undefined;
  const evalCtx: EvaluationContext = {
    body: wi?.body ?? '',
    fields: wi?.fields ?? {},
    // Section 26 carry-over #2 — surface `content` so `body_contains` can
    // search both body + attachments.
    attachments: attachments.map((a) => ({ name: a.name, content: a.content })),
    childWorkItems: children.map((c) => ({ status: c.status })),
    // Slice 014a — evidence sources for the v2 predicates.
    report: contract.report ?? '',
    toolCalls: (await deps.loadToolCalls?.(input)) ?? [],
    pendingAskCreated: (await deps.loadPendingAskCreated?.(input)) ?? false,
    payload: deliverable?.kind === 'payload' ? deliverable.data : undefined,
    externalHandle: deliverable?.kind === 'external' ? deliverable.handle ?? null : undefined,
  };

  const executors = (deps.executorsFor ?? createWorktreeExecutors)(input);
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
 *  accept path). */
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
  if (workItemId) {
    applyRunOutcome(workItemId, 'complete', null, historyNote);
    if (input.project) autoAdvanceToDoneStage(workItemId, input.project);
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

// ── Predicate executors ────────────────────────────────────────────────────

/** Production `PredicateExecutors` bound to a worktree + project root.
 *  `fileSize` is worktree-scoped: relative paths must resolve inside the
 *  worktree (path-guard parity with the worktree-bound bash hook). */
export function createWorktreeExecutors(input: {
  worktreeDir: string;
  projectFolderPath: string;
  bashTimeoutMs?: number;
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
    async runBash(command, cwd) {
      const cwdAbs = cwd === 'project' ? input.projectFolderPath : input.worktreeDir;
      return await new Promise<number>((resolveResult) => {
        let settled = false;
        const child = spawn(command, { shell: true, cwd: cwdAbs });
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            child.kill('SIGKILL');
          } catch {
            /* best-effort kill — fall through to the 124 resolution */
          }
          // 124 mirrors GNU `timeout`'s convention so the predicate failure
          // reason is recognizable in the channel-event tag.
          resolveResult(124);
        }, bashTimeoutMs);
        child.on('error', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // 127 mirrors a "command not found" exit; surfaces the same way
          // through the predicate failure path.
          resolveResult(127);
        });
        child.on('exit', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveResult(code ?? 0);
        });
      });
    },
    async hasGitDiff(cwd) {
      // True iff the tree has any change — tracked, staged, or untracked.
      // `git status --porcelain` prints one line per change; empty = clean.
      const cwdAbs = cwd === 'project' ? input.projectFolderPath : input.worktreeDir;
      return await new Promise<boolean>((resolveResult) => {
        let settled = false;
        let out = '';
        const child = spawn('git', ['status', '--porcelain'], { cwd: cwdAbs });
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveResult(value);
        };
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* best-effort */
          }
          finish(false);
        }, bashTimeoutMs);
        child.stdout?.on('data', (d) => {
          out += String(d);
        });
        child.on('error', () => finish(false));
        child.on('exit', () => finish(out.trim().length > 0));
      });
    },
  };
}

/** True iff `abs` resolves under `root` (exclusive of `root` itself). Reject
 *  exact-match + escapes. */
function isInside(abs: string, root: string): boolean {
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  return true;
}
