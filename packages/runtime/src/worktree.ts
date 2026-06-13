// Worktree primitive. Shells out to git from a workspace cwd.
// Both @pc/mcp (orchestrator-facing tools) and @pc/server (UI-facing API)
// call into this.
//
// Path policy is the caller's responsibility: every mutating primitive takes
// an absolute `wtPath`. In PC's multi-tenant layout the service layer computes
// `<data_dir>/worktrees/<slug>/<name>/`; the rig used `<workspace>/../worktrees/<name>/`.
// The primitive does not care which.
//
// In PC this sits alongside pty-session.ts as a runtime primitive; the
// apps/server service layer wraps it with persistence + per-project scoping.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const _exec = promisify(execFile);

/** Thin wrapper: re-throws with stderr appended so callers see the real git
 *  error instead of the generic "Command failed: git ..." envelope. */
async function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string },
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await _exec(cmd, args, opts) as { stdout: string; stderr: string };
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const detail = e.stderr?.trim();
    if (detail) throw new Error(`${e.message}: ${detail}`);
    throw err;
  }
}

export interface WorktreeEntry {
  /** Absolute path on disk. */
  path: string;
  /** Short branch ref the worktree is checked out on, or null for detached. */
  branch: string | null;
  /** Commit SHA. */
  head: string;
}

const BRANCH_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function assertBranchName(name: string): void {
  if (!BRANCH_NAME_RE.test(name)) {
    throw new Error(`invalid worktree name: ${JSON.stringify(name)} (must match [a-zA-Z0-9._-]+)`);
  }
}

/** Integration-branch ref shape. Mirrors @pc/domain INTEGRATION_BRANCH_RE
 *  (runtime stays dependency-free of domain). Unlike BRANCH_NAME_RE (which
 *  guards GENERATED run-branch names), this allows `/` — `release/2026`-style
 *  integration branches are legitimate user config. */
const INTEGRATION_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function assertIntegrationBranch(name: string): void {
  if (!INTEGRATION_BRANCH_RE.test(name)) {
    throw new Error(`invalid integration branch: ${JSON.stringify(name)}`);
  }
}

/**
 * Create a worktree at `wtPath` on a fresh branch named `branchName`.
 * Caller owns the path; this primitive only runs `git worktree add wtPath -b branchName`.
 */
export async function createWorktree(
  workspaceDir: string,
  wtPath: string,
  branchName: string,
): Promise<WorktreeEntry> {
  assertBranchName(branchName);
  const wsAbs = resolve(workspaceDir);
  const wtAbs = resolve(wtPath);
  await exec('git', ['worktree', 'add', wtAbs, '-b', branchName], { cwd: wsAbs });
  const all = await listWorktrees(wsAbs);
  const entry = all.find((w) => normalize(w.path) === normalize(wtAbs));
  if (!entry) throw new Error(`worktree created but not found in list: ${wtAbs}`);
  return entry;
}

export async function listWorktrees(workspaceDir: string): Promise<WorktreeEntry[]> {
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], {
    cwd: resolve(workspaceDir),
  });
  return parsePorcelain(stdout);
}

/**
 * Remove a worktree at `wtPath` (absolute). Caller resolves names to paths.
 */
export async function destroyWorktree(
  workspaceDir: string,
  wtPath: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const wsAbs = resolve(workspaceDir);
  const wtAbs = resolve(wtPath);
  const args = ['worktree', 'remove'];
  if (opts.force) args.push('--force');
  args.push(wtAbs);
  await exec('git', args, { cwd: wsAbs });
}

/** Clean up worktree registrations for paths that no longer exist on disk. */
export async function pruneWorktrees(workspaceDir: string): Promise<void> {
  await exec('git', ['worktree', 'prune'], { cwd: resolve(workspaceDir) });
}

/**
 * True when `branch`'s work has landed on the integration branch (local or
 * origin counterpart). Two positive forms, both conservative:
 *
 *  1. ANCESTRY — the branch tip is an ancestor (a real `git merge` landed it).
 *  2. PATCH EQUIVALENCE — `git cherry <target> <branch>` reports every branch
 *     commit as `-` (an equivalent patch exists upstream). This is how
 *     cherry-pick / rebase-style integration flows land work: the commits are
 *     COPIED, so the tip is never an ancestor, but deleting the branch loses
 *     nothing. Any `+` line (a commit with no upstream equivalent) → NOT
 *     landed → kept.
 *
 * False when the branch doesn't exist or isn't landed — callers use this as
 * the safety gate before teardown.
 */
export async function branchMergedInto(
  workspaceDir: string,
  branch: string,
  integrationBranch: string,
): Promise<boolean> {
  assertBranchName(branch);
  assertIntegrationBranch(integrationBranch);
  const cwd = resolve(workspaceDir);
  const targets = [integrationBranch, `origin/${integrationBranch}`];
  for (const target of targets) {
    try {
      await exec('git', ['merge-base', '--is-ancestor', branch, target], { cwd });
      return true;
    } catch {
      /* not an ancestor of this target (or ref missing) — try the next */
    }
  }
  for (const target of targets) {
    try {
      const { stdout } = await exec('git', ['cherry', target, branch], { cwd });
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
      // Zero lines = nothing ahead of the merge-base (ancestry would normally
      // have caught this); all '-' = every commit has an upstream equivalent.
      if (lines.every((l) => l.startsWith('-'))) return true;
    } catch {
      /* target ref missing — try the next */
    }
  }
  return false;
}

/**
 * Delete local branch `branch` unconditionally (`-D`). Callers must verify
 * merge state first (`branchMergedInto`) — this primitive does not check.
 */
export async function deleteBranch(workspaceDir: string, branch: string): Promise<void> {
  assertBranchName(branch);
  await exec('git', ['branch', '-D', branch], { cwd: resolve(workspaceDir) });
}

/** List local branch names starting with any of `prefixes`. */
export async function listBranchesByPrefix(
  workspaceDir: string,
  prefixes: string[],
): Promise<string[]> {
  const patterns = prefixes.map((p) => `refs/heads/${p}*`);
  const { stdout } = await exec(
    'git',
    ['for-each-ref', '--format=%(refname:short)', ...patterns],
    { cwd: resolve(workspaceDir) },
  );
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Attach an existing branch as a worktree at `wtPath` (no `-b`). Used to
 * recover from "branch exists but worktree dir is gone" — i.e. orphaned
 * branch from a failed prior dispatch.
 */
export async function attachWorktree(
  workspaceDir: string,
  wtPath: string,
  branchName: string,
): Promise<WorktreeEntry> {
  assertBranchName(branchName);
  const wsAbs = resolve(workspaceDir);
  const wtAbs = resolve(wtPath);
  await exec('git', ['worktree', 'add', wtAbs, branchName], { cwd: wsAbs });
  const all = await listWorktrees(wsAbs);
  const entry = all.find((w) => normalize(w.path) === normalize(wtAbs));
  if (!entry) throw new Error(`worktree attached but not found in list: ${wtAbs}`);
  return entry;
}

// ---------------------------------------------------------------------------
// Merge / push primitives (pc-pty-chat-270 — verified engine git action)
// ---------------------------------------------------------------------------

export interface GitMergeState {
  /** Branch tip is already an ancestor of the integration branch (landed). */
  alreadyMerged: boolean;
  /** `.git/MERGE_HEAD` is present — a merge is in progress or conflicted. */
  mergeInProgress: boolean;
  /** `origin/<integration>` points at the same commit as the local target. */
  pushed: boolean;
}

/**
 * Read-only inspection of merge / push state for `branch` relative to the
 * integration branch. All checks are non-destructive. Returns `false`
 * conservatively when a ref lookup fails (e.g. no origin configured yet, or
 * branch unknown).
 *
 * When called from the engine-controlled merge worktree (which is in
 * **detached HEAD** state), uses `HEAD` as the merge target ref instead of the
 * integration branch pointer. This correctly tracks the merge commit that was
 * just created and lets the idempotent reconcile see `alreadyMerged: true`
 * without needing to advance the local branch ref (which would require
 * modifying the main checkout's branch tracking).
 *
 * `alreadyMerged` also falls back to checking `origin/<integration>` — this
 * covers the restart/worktree-recreated case: if the worktree was removed and
 * recreated at the integration branch's old pre-merge tip, but origin already
 * has the merge commit, the branch is still considered merged (don't re-merge).
 */
export async function gitMergeState(
  workspaceDir: string,
  branch: string,
  integrationBranch: string,
): Promise<GitMergeState> {
  assertBranchName(branch);
  assertIntegrationBranch(integrationBranch);
  const cwd = resolve(workspaceDir);
  const originRef = `origin/${integrationBranch}`;

  // Detect if we're in detached HEAD (the merge worktree uses --detach).
  // When detached, use HEAD as the "merge target" ref rather than the branch
  // pointer, since the merge commit advances HEAD only.
  let target = integrationBranch;
  try {
    const abbrev = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim();
    if (abbrev === 'HEAD') target = 'HEAD'; // detached — use HEAD as the merge target
  } catch {
    /* fallback to the integration branch pointer */
  }

  // alreadyMerged: branch tip is an ancestor of target, with an origin
  // fallback for the "restart after push" scenario (worktree recreated at the
  // old pre-merge tip while origin already has the merge commit).
  let alreadyMerged = false;
  try {
    await exec('git', ['merge-base', '--is-ancestor', branch, target], { cwd });
    alreadyMerged = true;
  } catch {
    /* not an ancestor of target */
  }
  if (!alreadyMerged) {
    try {
      await exec('git', ['merge-base', '--is-ancestor', branch, originRef], { cwd });
      alreadyMerged = true;
    } catch {
      /* not merged via origin either — genuinely not merged */
    }
  }

  // mergeInProgress: MERGE_HEAD present ⇒ a merge was started but not committed.
  // Each worktree has its own MERGE_HEAD, so this correctly reflects a conflict
  // that occurred in the merge worktree (not in the main checkout).
  let mergeInProgress = false;
  try {
    await exec('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd });
    mergeInProgress = true;
  } catch {
    /* absent → no merge in progress */
  }

  // pushed: target SHA == origin SHA. In detached HEAD mode, target is HEAD
  // (the merge commit); in branch mode, the integration branch pointer.
  let pushed = false;
  try {
    const [localRes, remoteRes] = await Promise.all([
      exec('git', ['rev-parse', target], { cwd }),
      exec('git', ['rev-parse', originRef], { cwd }),
    ]);
    pushed = localRes.stdout.trim() === remoteRes.stdout.trim();
  } catch {
    /* no origin counterpart (no remote, or not yet pushed) → false */
  }

  return { alreadyMerged, mergeInProgress, pushed };
}

/**
 * Merge `branch` into the current HEAD (expected: the merge worktree detached
 * at the integration tip) with `--no-ff`. Throws on conflict or any other
 * failure. Callers must check `gitMergeState` for idempotency before calling
 * (if `alreadyMerged` is true, skip this).
 */
export async function mergeBranchIntoHead(
  workspaceDir: string,
  branch: string,
): Promise<void> {
  assertBranchName(branch);
  await exec('git', ['merge', '--no-ff', branch], { cwd: resolve(workspaceDir) });
}

/**
 * Push `ref` to `origin`. `ref` can be a branch name (`'dev'`) or a refspec
 * (`'HEAD:dev'`). The refspec form is used by the merge worktree when it is
 * in detached HEAD state to push the merge commit to the origin integration
 * branch without needing a local branch pointer.
 */
export async function pushBranch(workspaceDir: string, ref: string): Promise<void> {
  // No assertBranchName here — `ref` may be a refspec like 'HEAD:dev'.
  await exec('git', ['push', 'origin', ref], { cwd: resolve(workspaceDir) });
}

/**
 * Ensure a lightweight git worktree at `wtPath` for merge operations, checked
 * out in **detached HEAD** at the integration branch's current commit. Using
 * `--detach` avoids the git constraint that prevents two worktrees from
 * tracking the same branch simultaneously (the main checkout is often on the
 * integration branch).
 *
 * No pnpm install is run — a merge worktree needs no node_modules.
 *
 * Idempotent, with a LINEAGE GUARD: an existing detached worktree is reused
 * only when (a) it has a MERGE_HEAD (a conflict someone is parked on — never
 * destroy that state), or (b) its HEAD contains the integration tip (i.e. it
 * is at the tip, or holds not-yet-pushed merge commits on top of it). Anything
 * else is STALE — out-of-band merges advanced the integration branch under it,
 * or the integration-branch setting changed — and is force-removed and
 * recreated at the current tip. A dropped diverged merge commit is simply
 * re-merged by the idempotent reconcile; keeping it would guarantee a non-FF
 * push reject instead.
 *
 * Throws if the worktree exists on a different, unexpected branch.
 */
export async function ensureMergeWorktree(
  workspaceDir: string,
  wtPath: string,
  integrationBranch: string,
): Promise<void> {
  assertIntegrationBranch(integrationBranch);
  const wsAbs = resolve(workspaceDir);
  const wtAbs = resolve(wtPath);
  // Prune stale registrations so a removed-dir doesn't block the add.
  await exec('git', ['worktree', 'prune'], { cwd: wsAbs });
  const all = await listWorktrees(wsAbs);
  const existing = all.find((w) => normalize(w.path) === normalize(wtAbs));
  if (existing) {
    if (existing.branch !== null && existing.branch !== integrationBranch) {
      throw new Error(
        `merge worktree at ${wtAbs} is on branch "${existing.branch}", expected detached HEAD or "${integrationBranch}" — remove and retry`,
      );
    }
    // Parked conflict? Never destroy MERGE_HEAD state.
    let hasMergeHead = false;
    try {
      await exec('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: wtAbs });
      hasMergeHead = true;
    } catch {
      /* no merge in progress */
    }
    if (hasMergeHead) return;
    // Lineage check: HEAD must contain the integration tip.
    try {
      await exec('git', ['merge-base', '--is-ancestor', integrationBranch, 'HEAD'], {
        cwd: wtAbs,
      });
      return; // current (or ahead with unpushed merge commits) — reuse
    } catch {
      /* stale — fall through to recreate */
    }
    await exec('git', ['worktree', 'remove', '--force', wtAbs], { cwd: wsAbs });
  }
  // Create in detached HEAD at the integration tip. --detach works even when
  // the main checkout is on the same branch (avoids "already used by worktree").
  await exec('git', ['worktree', 'add', '--detach', wtAbs, integrationBranch], { cwd: wsAbs });
}

/**
 * One-time integration-branch auto-detection for a repo with no explicit
 * setting. Order: local `dev` (preserves the pre-parameterization semantics
 * for every repo that has one) → origin's default branch (`origin/HEAD`) →
 * the currently checked-out branch. Returns null when nothing is detectable
 * (detached HEAD in an empty repo, etc.) — callers must fail loudly, never
 * default silently.
 */
export async function detectIntegrationBranch(workspaceDir: string): Promise<string | null> {
  const cwd = resolve(workspaceDir);
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/dev'], { cwd });
    return 'dev';
  } catch {
    /* no local dev */
  }
  try {
    const short = (
      await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd })
    ).stdout.trim();
    const name = short.replace(/^origin\//, '');
    if (name && INTEGRATION_BRANCH_RE.test(name)) return name;
  } catch {
    /* no origin/HEAD (no remote, or never cloned) */
  }
  try {
    const current = (
      await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    ).stdout.trim();
    if (current && current !== 'HEAD' && INTEGRATION_BRANCH_RE.test(current)) return current;
  } catch {
    /* not a repo / unborn HEAD */
  }
  return null;
}

/**
 * Read the current branch name and tree cleanliness of the worktree at
 * `wtPath`. Used as a pre-merge guard: the merge worktree must be on the
 * integration branch (or detached) with no uncommitted changes before
 * `git merge` is invoked.
 *
 * Returns `branch: null` when the worktree is in detached HEAD state.
 */
export async function getWorktreeStatus(
  wtPath: string,
): Promise<{ branch: string | null; clean: boolean }> {
  const cwd = resolve(wtPath);
  const [branchRes, statusRes] = await Promise.all([
    exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
    exec('git', ['status', '--porcelain'], { cwd }),
  ]);
  const raw = branchRes.stdout.trim();
  const branch = raw === 'HEAD' ? null : raw; // 'HEAD' = detached
  const clean = statusRes.stdout.trim() === '';
  return { branch, clean };
}

function parsePorcelain(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur.path) out.push(finalize(cur));
      cur = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      cur.branch = ref.replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.branch = null;
    }
  }
  if (cur.path) out.push(finalize(cur));
  return out;
}

function finalize(c: Partial<WorktreeEntry>): WorktreeEntry {
  return { path: c.path!, branch: c.branch ?? null, head: c.head ?? '' };
}

function normalize(p: string): string {
  return resolve(p).toLowerCase();
}
