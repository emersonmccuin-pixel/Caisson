// Section 26.5 — tier-1 acceptance-criteria verification on AgentRun terminal.
//
// Called from `agent-run-factory.ts` after every dispatched agent's terminal
// transition. Looks up the contract work item (`pc_create_agent_work_item`'s
// output), runs the predicate evaluator, atomically flips the work item to
// `complete` / `failed` / `awaiting-verification`, and returns a structured
// summary the caller folds into the `agent-completed` / `agent-failed`
// channel envelope.
//
// Tier semantics (locked at the agent output contract § "Verification flow"):
//   - auto: predicates run; pass = complete, fail = failed.
//   - orchestrator-review / human-review: WI flips to `awaiting-verification`
//     with `verification_status = 'pending'`; the approve/reject tools (26.6)
//     drive the next transition.
//
// Terminal-status semantics:
//   - completed → tier-1 predicate eval (or tier-2/3 hold).
//   - failed → WI fails immediately, no predicate eval; the agent died before
//     reporting done.
//   - cancelled → no automatic WI update; the orchestrator decided to abandon
//     this dispatch and owns the next step (re-dispatch, edit AC, archive).
//
// Predicate execution is sandboxed: `fileSize` rejects relative paths that
// escape the worktree; `runBash` runs with a 30s hard timeout via SIGKILL.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  applyAgentVerification,
  getWorkItem,
  listAttachmentsForWorkItem,
  listChildWorkItems,
  listContractsForWorkItem,
  type ContractRow,
} from '@pc/db';
import type {
  EvaluationContext,
  PredicateExecutors,
  Project,
  ULID,
  VerificationStatus,
  VerificationTier,
  WorkItemStatus,
} from '@pc/domain';
import { evaluateAcceptance } from '@pc/domain';

import { autoAdvanceToDoneStage } from './auto-advance-done.ts';

/** Default cap on a single `bash_exit_zero` predicate. Keeps the terminal
 *  handler from blocking on a runaway verifier script. Override per test. */
const DEFAULT_BASH_TIMEOUT_MS = 30_000;

export interface RunVerificationInput {
  /** The contract work item id passed to `pc_invoke_agent`. Null = the
   *  dispatch was not a contract dispatch; verification is a no-op. */
  workItemId: ULID | null;
  terminalStatus: 'completed' | 'failed' | 'cancelled';
  /** Human-readable failure summary when `terminalStatus === 'failed'`. Used
   *  as the work item's status reason + verification notes. */
  failureReason: string | null;
  /** Project root absolute path. Used as `cwd` for predicates declaring
   *  `cwd: 'project'`. */
  projectFolderPath: string;
  /** Agent's worktree absolute path. Default `cwd` for `bash_exit_zero` +
   *  the resolution root for `files_exist` relative paths. */
  worktreeDir: string;
  /** Section 27.7 — full project record. When provided + verification PASS
   *  resolves + the project has an `is_done` stage, the WI auto-advances
   *  there after the status flip. `null` skips auto-advance (test paths
   *  that don't care about stage motion). */
  project?: Project | null;
}

export interface VerificationOutcome {
  workItemId: ULID;
  workItemStatus: WorkItemStatus;
  verificationStatus: VerificationStatus;
  verificationTier: VerificationTier;
  /** Human-readable summary suitable for the channel-event tag. `null` when
   *  the WI flipped to a non-failure state with no diagnostic to surface. */
  notes: string | null;
  /** Number of predicates that were evaluated. Zero for tier-2/3 holds + for
   *  the failed-agent path (predicates skipped). */
  predicatesEvaluated: number;
}

export interface VerificationDeps {
  /** Inject the predicate executors for tests. Production constructs a
   *  worktree-bound impl via `createWorktreeExecutors`. */
  executorsFor?: (input: RunVerificationInput) => PredicateExecutors;
  now?: () => number;
}

/** Run the verification pass for one terminal AgentRun. Returns null when
 *  no verification ran (no contract WI, missing WI, cancelled, or a
 *  non-agent-task WI was supplied). The terminal-envelope builder treats
 *  `null` as "no verification block on the envelope." */
export async function runVerificationOnTerminal(
  input: RunVerificationInput,
  deps: VerificationDeps = {},
): Promise<VerificationOutcome | null> {
  if (!input.workItemId) return null;

  const wi = getWorkItem(input.workItemId);
  if (!wi) return null;
  // Defensive guard — only flip work items that opted into the contract
  // surface. Lineage work items (`is_agent_task: false`) stay untouched even
  // if a dispatch's `parent_work_item_id` happened to point at them.
  if (!wi.isAgentTask) return null;

  // Slice 013 — read the verification spec THROUGH the contract shim: prefer the
  // first-class contract's tier/AC, fall back to the WI's legacy columns for any
  // un-backfilled row. The contract's bytes are copied verbatim from the WI
  // (backfill + createAgentWorkItem), so this is byte-identical. We STILL flip
  // the WI exactly as before — only the data source moved.
  const contract = resolveContractFor(input.workItemId);
  const tier: VerificationTier =
    contract?.verificationTier ?? wi.verificationTier ?? 'auto';

  // Agent died before reporting done. No predicate eval — the contract
  // can't be satisfied if the agent never finished the body / attachments
  // / fields the criteria check against.
  if (input.terminalStatus === 'failed') {
    const notes = input.failureReason ?? 'agent run failed';
    applyAgentVerification(input.workItemId, {
      workItemStatus: 'failed',
      statusReason: notes,
      verificationStatus: 'failed',
      verificationNotes: notes,
      historyNote: `verification skipped: ${notes}`,
    });
    return {
      workItemId: input.workItemId,
      workItemStatus: 'failed',
      verificationStatus: 'failed',
      verificationTier: tier,
      notes,
      predicatesEvaluated: 0,
    };
  }

  // Cancelled by the orchestrator or user. The dispatch was abandoned on
  // purpose; don't auto-flip the WI — the caller has already chosen to
  // walk away. They own the next move (re-dispatch / edit AC / archive).
  if (input.terminalStatus === 'cancelled') return null;

  // Tier-2 / tier-3 hold. Approve/reject tools land in 26.6 and drive the
  // next transition. For v1 we just park the WI in `awaiting-verification`
  // with `verification_status: 'pending'`.
  if (tier === 'orchestrator-review' || tier === 'human-review') {
    applyAgentVerification(input.workItemId, {
      workItemStatus: 'awaiting-verification',
      statusReason: `agent reported done — pending ${tier} verification`,
      verificationStatus: 'pending',
      verificationNotes: null,
      historyNote: `awaiting ${tier} verification`,
    });
    return {
      workItemId: input.workItemId,
      workItemStatus: 'awaiting-verification',
      verificationStatus: 'pending',
      verificationTier: tier,
      notes: null,
      predicatesEvaluated: 0,
    };
  }

  // Tier-1 auto. Empty AC = "trust the agent's end-of-turn signal" per the
  // derivation library — flip directly to complete with no diagnostic.
  // Slice 013 — AC sourced through the contract shim (same bytes; WI fallback).
  const criteria = contract?.acceptanceCriteria ?? wi.acceptanceCriteria ?? [];
  if (criteria.length === 0) {
    applyAgentVerification(input.workItemId, {
      workItemStatus: 'complete',
      statusReason: null,
      verificationStatus: 'passed',
      verificationNotes: null,
      historyNote: 'verification passed (no predicates)',
    });
    if (input.project) autoAdvanceToDoneStage(input.workItemId, input.project);
    return {
      workItemId: input.workItemId,
      workItemStatus: 'complete',
      verificationStatus: 'passed',
      verificationTier: 'auto',
      notes: null,
      predicatesEvaluated: 0,
    };
  }

  const attachments = listAttachmentsForWorkItem(input.workItemId);
  const children = listChildWorkItems(input.workItemId);
  const evalCtx: EvaluationContext = {
    body: wi.body,
    fields: wi.fields,
    // Section 26 carry-over #2 — surface `content` so `body_contains` can
    // search both body + attachments. Agents commonly persist non-trivial
    // deliverables as attachments.
    attachments: attachments.map((a) => ({ name: a.name, content: a.content })),
    childWorkItems: children.map((c) => ({ status: c.status })),
  };

  const executors = (deps.executorsFor ?? createWorktreeExecutors)(input);
  const { pass, failures } = await evaluateAcceptance(criteria, evalCtx, executors);

  if (pass) {
    const predicateWord = criteria.length === 1 ? 'predicate' : 'predicates';
    applyAgentVerification(input.workItemId, {
      workItemStatus: 'complete',
      statusReason: null,
      verificationStatus: 'passed',
      verificationNotes: null,
      historyNote: `verification passed (tier-1, ${criteria.length} ${predicateWord})`,
    });
    if (input.project) autoAdvanceToDoneStage(input.workItemId, input.project);
    return {
      workItemId: input.workItemId,
      workItemStatus: 'complete',
      verificationStatus: 'passed',
      verificationTier: 'auto',
      notes: null,
      predicatesEvaluated: criteria.length,
    };
  }

  // Tier-1 fail. Persist the per-predicate failure list as JSON for the
  // future Activity Panel renderer; the human-readable summary lives in
  // the history note + the channel-event tag.
  const summary = failures.map((f) => `${f.kind}: ${f.reason}`).join('; ');
  applyAgentVerification(input.workItemId, {
    workItemStatus: 'failed',
    statusReason: 'tier-1 acceptance criteria failed',
    verificationStatus: 'failed',
    verificationNotes: JSON.stringify(failures),
    historyNote: `verification failed: ${summary}`,
  });
  return {
    workItemId: input.workItemId,
    workItemStatus: 'failed',
    verificationStatus: 'failed',
    verificationTier: 'auto',
    notes: summary,
    predicatesEvaluated: criteria.length,
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
  };
}

/** Slice 013 — resolve the first-class contract backing a contract WI (the
 *  read-through shim source for tier/AC). Prefers the dispatched contract (one
 *  with a run); else the most recent. Returns null for un-backfilled WIs, where
 *  the caller falls back to the WI's legacy columns. Best-effort. */
function resolveContractFor(workItemId: ULID): ContractRow | null {
  try {
    const contracts = listContractsForWorkItem(workItemId);
    if (contracts.length === 0) return null;
    const dispatched = contracts.filter((c) => c.agentRunId !== null);
    const pool = dispatched.length > 0 ? dispatched : contracts;
    return pool[pool.length - 1] ?? null;
  } catch {
    return null;
  }
}

/** True iff `abs` resolves under `root` (exclusive of `root` itself). Reject
 *  exact-match + escapes. */
function isInside(abs: string, root: string): boolean {
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  return true;
}
