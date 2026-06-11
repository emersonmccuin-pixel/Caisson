// Worktree sweep runner — boot + periodic backstop for the merge-node
// teardown.
//
// This is a RESOURCE JANITOR reconciling disk against git, distinct from the
// agent-run reconciler (the ONE-RECONCILER guard governs run-STATE
// reconciliation). It exists on an interval because out-of-band merges (the
// orchestrator running git itself) produce no event the engine can hook —
// polling git state is the honest reconcile until pc-pty-chat-270's verified
// engine git lands merge receipts, and it remains the backstop after.
//
// Per-project isolation: one project's resolver/git failure is logged and
// must never stop the others. Positive receipt: kept-with-reason at info,
// every removal FAILURE at warn (the 2026-06-11 incident was four lock-failed
// removals that read as silent keeps).

import type { WorktreeService, WorktreeSweepResult } from './worktree.ts';

export interface WorktreeSweepRunnerDeps {
  /** Projects to sweep (id + slug for logs). */
  listProjects: () => Array<{ id: string; slug: string }>;
  /** Project runtime accessor; null = project not registered. */
  getRuntime: (
    projectId: string,
  ) => { worktrees(): WorktreeService; worktreeBaseDir: string } | null;
  /** Worktree paths referenced by live runs — recomputed EVERY run. */
  collectInUse: () => string[];
  /** Dir-existence probe (default: fs.existsSync injected by the caller). */
  dirExists: (path: string) => boolean;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface WorktreeSweepRunner {
  /** Sweep all projects once. Re-entrancy-guarded: a call while a sweep is
   *  already running resolves immediately without sweeping. */
  runOnce(): Promise<void>;
}

function summarize(slug: string, r: WorktreeSweepResult): string {
  const keptByReason = new Map<string, number>();
  for (const k of r.kept) keptByReason.set(k.reason, (keptByReason.get(k.reason) ?? 0) + 1);
  const keptStr = [...keptByReason.entries()].map(([reason, n]) => `${n} ${reason}`).join(', ');
  return (
    `[worktree-sweep] ${slug}: removed ${r.removedWorktrees.length} worktrees, ` +
    `${r.deletedBranches.length} branches, ${r.removedHusks.length} husks` +
    (keptStr ? ` (kept ${keptStr})` : '') +
    (r.failed.length ? ` (${r.failed.length} FAILED)` : '')
  );
}

export function createWorktreeSweepRunner(deps: WorktreeSweepRunnerDeps): WorktreeSweepRunner {
  const log = deps.log ?? ((msg) => console.log(msg));
  const warn = deps.warn ?? ((msg) => console.warn(msg));
  let inFlight = false;

  return {
    async runOnce(): Promise<void> {
      if (inFlight) return; // a slow git/disk pass outliving the interval must not stack
      inFlight = true;
      try {
        let inUse: string[];
        try {
          inUse = deps.collectInUse();
        } catch (err) {
          warn(`[worktree-sweep] in-use scan failed, skipping sweep: ${(err as Error).message}`);
          return;
        }
        for (const p of deps.listProjects()) {
          const runtime = deps.getRuntime(p.id);
          // No worktree dir on disk = this project never dispatched isolated runs.
          if (!runtime || !deps.dirExists(runtime.worktreeBaseDir)) continue;
          try {
            const r = await runtime.worktrees().sweepStale(inUse);
            const didWork =
              r.removedWorktrees.length || r.deletedBranches.length || r.removedHusks.length;
            if (didWork || r.failed.length) log(summarize(p.slug, r));
            for (const f of r.failed) {
              warn(`[worktree-sweep] ${p.slug}: ${f.op} FAILED for "${f.name}": ${f.message}`);
            }
          } catch (err) {
            // Resolver failure (no detectable integration branch) or git error —
            // this project is skipped THIS pass; the others still sweep.
            warn(`[worktree-sweep] ${p.slug} failed: ${(err as Error).message}`);
          }
        }
      } finally {
        inFlight = false;
      }
    },
  };
}
