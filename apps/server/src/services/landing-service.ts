// pc-pty-chat-415 (R5) — accept ⇒ land. THE one landing path.
//
// `landBranch` owns the merge mechanics (extracted verbatim from the workflow
// merge node): idempotent state read → merge → positive receipt #1 (ancestry)
// → push → positive receipt #2 (origin equals local) → best-effort worktree
// teardown. All git runs in the engine-controlled `__dev-merge` worktree via
// WorktreeService — never in the user's working copy.
//
// `landAcceptedContract` is the acceptance-side door: when a STANDALONE
// (non-workflow) repo-kind contract is accepted, its sealed branch lands on
// the project's integration branch through the same mechanics, with the
// outcome recorded durably on the contract (landing_status + receipts).
// Workflow-owned runs are skipped — their run lands ONCE via the workflow
// merge node (phases compose on the run branch; the run lands at the end).
//
// Landing states: 'pending' (in flight — boot re-drives a crash, mechanics
// are idempotent), 'landed', 'conflict' (durable gate; resolve then re-land
// through the same door), 'failed' (mechanics error; same re-land door).

import { basename, resolve } from 'node:path';

import { getActiveWorktreeByName, getAgentRunRow, getProjectById } from '@pc/db';
import { ContractService } from '@pc/app-services';
import type { ULID } from '@pc/domain';

import { headSha as defaultHeadSha } from './git-receipts.ts';

/** The slice of WorktreeService the mechanics need. */
export interface LandingWorktrees {
  integrationBranch(): Promise<string>;
  mergeState(branch: string): Promise<{ mergeInProgress: boolean; alreadyMerged: boolean; pushed: boolean }>;
  mergeBranchIntoIntegration(branch: string): Promise<void>;
  /** D1d (pc-pty-chat-440): branch is the run branch being landed; pushes from
   *  its per-landing merge worktree. Always required post-pc-pty-chat-443. */
  pushIntegration(branch: string): Promise<void>;
  teardownAfterMerge(branch: string): Promise<void>;
  /** pc-pty-chat-415 (R12) — reclaim the worktree DIR of abandoned work; the
   *  branch is preserved as the durable record. */
  teardownAfterAbandon(branch: string): Promise<void>;
  /**
   * pc-pty-chat-417 — belt-and-suspenders after a successful merge+push:
   * advance the LOCAL integration branch ref to the merge-worktree HEAD so
   * standard git tools see the merged work and the local ref is usable as a
   * start-point fallback. Optional: callers use `?.()`. No-op when the main
   * checkout is on the integration branch (corruption guard). Best-effort:
   * never throws.
   */
  tryAdvanceLocalIntegration?(): Promise<void>;
  /** D1d: tear down the per-landing merge worktree after a successful push.
   *  Optional: callers use `?.()`. Best-effort — sweep collects husks. */
  teardownLandingMergeWorktree?(branch: string): Promise<void>;
}

export type LandBranchResult =
  | { outcome: 'merged'; into: string; idempotent: boolean }
  | { outcome: 'conflict'; into: string | null }
  | { outcome: 'failed'; into: string | null; error: string };

/** Idempotent merge → receipts → push → receipts → teardown. The ONE set of
 *  landing mechanics; the workflow merge node and the acceptance door both
 *  call here. Never throws — every path is a typed outcome. */
export async function landBranch(
  worktrees: LandingWorktrees,
  branch: string,
): Promise<LandBranchResult> {
  // Resolve the merge target up front. A resolver failure (no configured
  // branch + nothing detectable, or a configured branch missing from the
  // repo) fails LOUDLY with the fix-it message.
  let into: string;
  try {
    into = await worktrees.integrationBranch();
  } catch (err) {
    return { outcome: 'failed', into: null, error: (err as Error).message };
  }

  // Worktree teardown — the branch has verifiably landed (both positive
  // receipts), so the run worktree + branch have no further purpose.
  // Best-effort: a teardown failure (Windows file lock, etc.) must never
  // fail an already-merged landing; the sweep retries leftovers.
  const teardownBestEffort = async (): Promise<void> => {
    try {
      await worktrees.teardownAfterMerge(branch);
    } catch (err) {
      console.warn(
        `[landing] worktree teardown after merge failed for "${branch}" (sweep will retry): ${(err as Error).message}`,
      );
    }
  };

  try {
    // Idempotent reconcile — read actual git state before doing anything.
    const state = await worktrees.mergeState(branch);

    if (state.mergeInProgress) {
      // MERGE_HEAD present: a prior (interrupted) merge attempt left a conflict.
      return { outcome: 'conflict', into };
    }

    if (state.alreadyMerged) {
      // Branch tip is already an ancestor of the integration branch — skip
      // the merge itself.
      if (!state.pushed) {
        try {
          // D1d: pass branch so push runs from the per-landing merge worktree.
          await worktrees.pushIntegration(branch);
        } catch (pushErr) {
          const msg = (pushErr as Error).message ?? '';
          if (/rejected|non-fast-forward/i.test(msg)) return { outcome: 'conflict', into };
          return { outcome: 'failed', into, error: `push to origin/${into} failed: ${msg}` };
        }
        const afterPush = await worktrees.mergeState(branch);
        if (!afterPush.pushed) {
          return {
            outcome: 'failed',
            into,
            error: `push to origin/${into} completed but origin/${into} != ${into}`,
          };
        }
      }
      // pc-pty-chat-417: advance the local integration ref so future
      // run worktrees fork from the landed state (best-effort, never throws).
      await worktrees.tryAdvanceLocalIntegration?.();
      // D1d: tear down the per-landing merge worktree after confirmed push.
      try {
        await worktrees.teardownLandingMergeWorktree?.(branch);
      } catch {
        /* best-effort — sweep collects husks */
      }
      await teardownBestEffort();
      return { outcome: 'merged', into, idempotent: true };
    }

    // Fresh merge: merge → positive receipt #1 → push → positive receipt #2.
    await worktrees.mergeBranchIntoIntegration(branch);

    const afterMerge = await worktrees.mergeState(branch);
    if (!afterMerge.alreadyMerged) {
      return {
        outcome: 'failed',
        into,
        error: `merge ran but branch tip is not an ancestor of ${into} — merge commit not found`,
      };
    }

    try {
      // D1d: pass branch so push runs from the per-landing merge worktree.
      await worktrees.pushIntegration(branch);
    } catch (pushErr) {
      const msg = (pushErr as Error).message ?? '';
      if (/rejected|non-fast-forward/i.test(msg)) return { outcome: 'conflict', into };
      return { outcome: 'failed', into, error: `push to origin/${into} failed: ${msg}` };
    }

    const afterPush = await worktrees.mergeState(branch);
    if (!afterPush.pushed) {
      return {
        outcome: 'failed',
        into,
        error: `push to origin/${into} completed but origin/${into} != ${into}`,
      };
    }

    // pc-pty-chat-417: advance the local integration ref so future
    // run worktrees fork from the landed state (best-effort, never throws).
    await worktrees.tryAdvanceLocalIntegration?.();
    // D1d: tear down the per-landing merge worktree after confirmed push.
    try {
      await worktrees.teardownLandingMergeWorktree?.(branch);
    } catch {
      /* best-effort — sweep collects husks */
    }
    await teardownBestEffort();
    return { outcome: 'merged', into, idempotent: false };
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown error';
    // Conflict thrown by mergeBranchIntoIntegration (git exits non-zero).
    if (/conflict|CONFLICT|Automatic merge failed/i.test(msg)) {
      return { outcome: 'conflict', into };
    }
    return { outcome: 'failed', into, error: msg };
  }
}

// ── Acceptance-side landing ──────────────────────────────────────────────────

/** Runtime accessor for per-project WorktreeServices, wired ONCE at boot
 *  (index.ts: `resolveProject(id)?.worktrees()`). Services can't import the
 *  project registry (it lives in index.ts), so the wiring is pushed in —
 *  mirrors the process-wide ActiveRunRegistry pattern. */
let worktreesAccessor: ((projectId: ULID) => LandingWorktrees | null) | null = null;

export function setLandingWorktreesAccessor(
  fn: (projectId: ULID) => LandingWorktrees | null,
): void {
  worktreesAccessor = fn;
}

export interface LandAcceptedContractDeps {
  worktreesFor?: (projectId: ULID) => LandingWorktrees | null;
  contractService?: ContractService;
  /** Notify the dispatcher (orchestrator) of a conflict/failed landing —
   *  best-effort; the durable truth is the contract's landing_status. */
  notify?: (msg: { contractId: ULID; runId: ULID | null; outcome: 'conflict' | 'failed'; branch: string; error?: string }) => void;
  now?: () => number;
}

export type LandAcceptedContractResult =
  | { applicable: false; reason: string }
  | { applicable: true; outcome: 'landed' | 'conflict' | 'failed'; branch: string; into: string | null; error?: string };

/** Land an ACCEPTED standalone repo contract on the integration branch.
 *
 *  Applicability guards (each returns `applicable: false`, recorded nowhere —
 *  landing state stays null):
 *    - contract exists, expectedOutput.kind === 'repo', verification passed
 *    - producing run exists and ran in an ISOLATED worktree (cwd != project
 *      folder; legacy in-place history is exempt)
 *    - run is NOT workflow-owned (worktree row carries a workflowRunId, or the
 *      worktree follows the wf-* naming) — the workflow merge node owns those
 *
 *  Otherwise: landing_status 'pending' → mechanics → 'landed' (+ receipts:
 *  branch, sealed sha, time) | 'conflict' | 'failed' (+ error), durably on the
 *  contract. Idempotent: re-driving a 'landed' contract short-circuits. */
export async function landAcceptedContract(
  contractId: ULID,
  deps: LandAcceptedContractDeps = {},
): Promise<LandAcceptedContractResult> {
  const service = deps.contractService ?? new ContractService();
  const now = deps.now ?? Date.now;

  const contract = service.get(contractId);
  if (!contract) return { applicable: false, reason: 'contract not found' };
  if (contract.landingStatus === 'landed') {
    return {
      applicable: true,
      outcome: 'landed',
      branch: contract.landedBranch ?? '',
      into: null,
    };
  }
  const spec = contract.expectedOutput as { kind?: unknown } | null;
  if (spec?.kind !== 'repo') return { applicable: false, reason: 'not a repo contract' };
  if (contract.verificationStatus !== 'passed') {
    return { applicable: false, reason: 'contract not accepted' };
  }

  const runId = (contract.agentRunId ?? null) as ULID | null;
  const run = runId ? getAgentRunRow(runId) : null;
  const worktreeDir = (run?.worktreeDir ?? contract.worktreePath ?? '').trim();
  if (!worktreeDir) return { applicable: false, reason: 'no worktree recorded for the run' };

  const project = getProjectById(contract.projectId as ULID);
  if (project) {
    const norm = (p: string) =>
      process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
    if (norm(worktreeDir) === norm(project.folderPath)) {
      return { applicable: false, reason: 'legacy in-place run — nothing to land' };
    }
  }

  const branch = basename(worktreeDir);
  if (!branch) return { applicable: false, reason: `cannot derive branch from ${worktreeDir}` };

  // Workflow-owned runs land via the workflow merge node — one landing per
  // run, after end-to-end acceptance, not per phase (plan decision D3).
  const wtRow = getActiveWorktreeByName(branch);
  if (wtRow?.workflowRunId || branch.startsWith('wf-')) {
    return { applicable: false, reason: 'workflow-owned run — the merge node lands it' };
  }

  const worktrees = (deps.worktreesFor ?? worktreesAccessor)?.(contract.projectId as ULID) ?? null;
  if (!worktrees) {
    service.setLanding({
      id: contractId,
      landingStatus: 'failed',
      landedBranch: branch,
      landingError: 'no worktree service available for this project',
    });
    return {
      applicable: true,
      outcome: 'failed',
      branch,
      into: null,
      error: 'no worktree service available for this project',
    };
  }

  // Durable in-flight marker — a crash between here and the outcome write is
  // re-driven at boot (mechanics are idempotent).
  service.setLanding({ id: contractId, landingStatus: 'pending', landedBranch: branch });

  const result = await landBranch(worktrees, branch);

  if (result.outcome === 'merged') {
    const sealedSha =
      (contract.deliverable as { commit?: string } | null)?.commit ?? null;
    service.setLanding({
      id: contractId,
      landingStatus: 'landed',
      landedBranch: branch,
      landedSha: sealedSha,
      landingError: null,
      landedAt: now(),
    });
    return { applicable: true, outcome: 'landed', branch, into: result.into };
  }

  const error = result.outcome === 'failed' ? result.error : `merge conflict landing "${branch}" into ${result.into ?? 'integration'} — resolve in the engine merge worktree, then re-land`;
  service.setLanding({
    id: contractId,
    landingStatus: result.outcome === 'conflict' ? 'conflict' : 'failed',
    landedBranch: branch,
    landingError: error,
  });
  deps.notify?.({
    contractId,
    runId,
    outcome: result.outcome === 'conflict' ? 'conflict' : 'failed',
    branch,
    error,
  });
  return { applicable: true, outcome: result.outcome === 'conflict' ? 'conflict' : 'failed', branch, into: result.into, error };
}

// ── Abandon (R12/R14) ────────────────────────────────────────────────────────

export interface AbandonContractDeps {
  worktreesFor?: (projectId: ULID) => LandingWorktrees | null;
  contractService?: ContractService;
  /** Test seam — reads the branch tip to preserve before reclaim. */
  headSha?: typeof defaultHeadSha;
  now?: () => number;
}

export type AbandonContractResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      branch: string;
      /** Tip recorded on the contract before the dir was reclaimed (null when
       *  the dir was already gone — the branch ref itself still preserves it). */
      preservedSha: string | null;
      /** 'removed' = worktree dir reclaimed; 'failed' = record stands, dir
       *  removal failed (Windows lock etc.) — re-POST the abandon to retry. */
      teardown: 'removed' | 'failed';
    };

/** Explicitly abandon a repo contract's unlanded work (R12: teardown only
 *  after the work is recorded). Order is non-negotiable: record the branch +
 *  tip on the contract FIRST, then reclaim the worktree DIR — the branch is
 *  preserved as the durable artifact. Refuses while the producing run is
 *  still active, and for workflow-owned runs (cancel/resume the workflow run
 *  instead). Idempotent: re-abandoning retries the teardown without
 *  overwriting the original preservation record. */
export async function abandonContractWorkspace(
  contractId: ULID,
  deps: AbandonContractDeps = {},
): Promise<AbandonContractResult> {
  const service = deps.contractService ?? new ContractService();
  const now = deps.now ?? Date.now;

  const contract = service.get(contractId);
  if (!contract) return { ok: false, reason: 'contract not found' };
  if (contract.landingStatus === 'landed') {
    return { ok: false, reason: 'work already landed — nothing to abandon' };
  }
  const spec = contract.expectedOutput as { kind?: unknown } | null;
  if (spec?.kind !== 'repo') return { ok: false, reason: 'not a repo contract' };

  const runId = (contract.agentRunId ?? null) as ULID | null;
  const run = runId ? getAgentRunRow(runId) : null;
  if (run && run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
    return { ok: false, reason: `producing run is still ${run.status} — cancel it first` };
  }

  const worktreeDir = (run?.worktreeDir ?? contract.worktreePath ?? '').trim();
  if (!worktreeDir) return { ok: false, reason: 'no worktree recorded for the run' };
  const project = getProjectById(contract.projectId as ULID);
  if (project) {
    const norm = (p: string) =>
      process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
    if (norm(worktreeDir) === norm(project.folderPath)) {
      return { ok: false, reason: 'legacy in-place run — nothing to reclaim' };
    }
  }
  const branch = basename(worktreeDir);
  const wtRow = getActiveWorktreeByName(branch);
  if (wtRow?.workflowRunId || branch.startsWith('wf-')) {
    return { ok: false, reason: 'workflow-owned run — cancel/resume the workflow run instead' };
  }

  // Record FIRST (R12). A re-abandon keeps the original record — the dir may
  // be gone by now and a null tip must not overwrite the preserved sha.
  let preservedSha = contract.landedSha ?? null;
  if (contract.landingStatus !== 'abandoned') {
    preservedSha = await (deps.headSha ?? defaultHeadSha)(worktreeDir);
    service.setLanding({
      id: contractId,
      landingStatus: 'abandoned',
      landedBranch: branch,
      landedSha: preservedSha,
      landingError: null,
      landedAt: now(),
    });
  }

  const worktrees = (deps.worktreesFor ?? worktreesAccessor)?.(contract.projectId as ULID) ?? null;
  if (!worktrees) return { ok: true, branch, preservedSha, teardown: 'failed' };
  try {
    await worktrees.teardownAfterAbandon(branch);
    return { ok: true, branch, preservedSha, teardown: 'removed' };
  } catch (err) {
    console.warn(
      `[landing] abandon teardown failed for "${branch}" (re-POST to retry): ${(err as Error).message}`,
    );
    return { ok: true, branch, preservedSha, teardown: 'failed' };
  }
}
