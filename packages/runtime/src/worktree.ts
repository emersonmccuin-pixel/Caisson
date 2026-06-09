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
  /** Branch tip is already an ancestor of dev (branch already merged). */
  alreadyMerged: boolean;
  /** `.git/MERGE_HEAD` is present — a merge is in progress or conflicted. */
  mergeInProgress: boolean;
  /** `origin/dev` points at the same commit as local `dev`. */
  pushed: boolean;
}

/**
 * Read-only inspection of merge / push state for `branch` relative to `dev`.
 * All checks are non-destructive. Returns `false` conservatively when a ref
 * lookup fails (e.g. no origin configured yet, or branch unknown).
 *
 * When called from the engine-controlled dev merge worktree (which is in
 * **detached HEAD** state), uses `HEAD` as the merge target ref instead of the
 * `dev` branch pointer. This correctly tracks the merge commit that was just
 * created and lets the idempotent reconcile see `alreadyMerged: true` without
 * needing to advance the local `dev` branch ref (which would require modifying
 * the main checkout's branch tracking).
 *
 * `alreadyMerged` also falls back to checking `origin/dev` — this covers the
 * restart/worktree-recreated case: if the worktree was removed and recreated at
 * `dev`'s old pre-merge tip, but `origin/dev` already has the merge commit,
 * the branch is still considered merged (don't re-merge).
 */
export async function gitMergeState(
  workspaceDir: string,
  branch: string,
): Promise<GitMergeState> {
  assertBranchName(branch);
  const cwd = resolve(workspaceDir);

  // Detect if we're in detached HEAD (the dev merge worktree uses --detach).
  // When detached, use HEAD as the "merge target" ref rather than 'dev', since
  // the merge commit advances HEAD (not the local 'dev' branch pointer).
  let target = 'dev';
  try {
    const abbrev = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim();
    if (abbrev === 'HEAD') target = 'HEAD'; // detached — use HEAD as the merge target
  } catch {
    /* fallback to 'dev' */
  }

  // alreadyMerged: branch tip is an ancestor of target.
  // Also check origin/dev as a fallback for the "restart after push" scenario:
  // if the dev worktree was removed and recreated at dev's old pre-merge tip,
  // origin/dev already has the merge commit, so the branch IS already merged.
  let alreadyMerged = false;
  try {
    await exec('git', ['merge-base', '--is-ancestor', branch, target], { cwd });
    alreadyMerged = true;
  } catch {
    /* not an ancestor of target */
  }
  if (!alreadyMerged) {
    try {
      await exec('git', ['merge-base', '--is-ancestor', branch, 'origin/dev'], { cwd });
      alreadyMerged = true;
    } catch {
      /* not merged via origin/dev either — genuinely not merged */
    }
  }

  // mergeInProgress: MERGE_HEAD present ⇒ a merge was started but not committed.
  // Each worktree has its own MERGE_HEAD, so this correctly reflects a conflict
  // that occurred in the dev worktree (not in the main checkout).
  let mergeInProgress = false;
  try {
    await exec('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd });
    mergeInProgress = true;
  } catch {
    /* absent → no merge in progress */
  }

  // pushed: target SHA == origin/dev SHA.
  // In detached HEAD mode, target is HEAD (the merge commit); in branch mode,
  // target is 'dev'. Either way, pushed means origin/dev is at the same commit.
  let pushed = false;
  try {
    const [localRes, remoteRes] = await Promise.all([
      exec('git', ['rev-parse', target], { cwd }),
      exec('git', ['rev-parse', 'origin/dev'], { cwd }),
    ]);
    pushed = localRes.stdout.trim() === remoteRes.stdout.trim();
  } catch {
    /* no origin/dev (no remote, or not yet pushed) → false */
  }

  return { alreadyMerged, mergeInProgress, pushed };
}

/**
 * Merge `branch` into the current HEAD (expected: `dev` or detached at dev's
 * tip) with `--no-ff`. Throws on conflict or any other failure. Callers must
 * check `gitMergeState` for idempotency before calling (if `alreadyMerged` is
 * true, skip this).
 */
export async function mergeBranchIntoDev(
  workspaceDir: string,
  branch: string,
): Promise<void> {
  assertBranchName(branch);
  await exec('git', ['merge', '--no-ff', branch], { cwd: resolve(workspaceDir) });
}

/**
 * Push `ref` to `origin`. `ref` can be a branch name (`'dev'`) or a refspec
 * (`'HEAD:dev'`). The refspec form is used by the dev merge worktree when it
 * is in detached HEAD state to push the merge commit to `origin/dev` without
 * needing a local branch pointer.
 */
export async function pushBranch(workspaceDir: string, ref: string): Promise<void> {
  // No assertBranchName here — `ref` may be a refspec like 'HEAD:dev'.
  await exec('git', ['push', 'origin', ref], { cwd: resolve(workspaceDir) });
}

/**
 * Ensure a lightweight git worktree at `devWtPath` for merge operations,
 * checked out in **detached HEAD** at `dev`'s current commit. Using `--detach`
 * avoids the git constraint that prevents two worktrees from tracking the same
 * branch simultaneously (the main checkout is often on `dev`).
 *
 * No pnpm install is run — a merge worktree needs no node_modules.
 *
 * Idempotent: prunes stale registrations first, returns immediately if the
 * worktree already exists in detached HEAD or on `dev`. Throws if the worktree
 * exists on a different, unexpected branch.
 */
export async function ensureDevWorktree(workspaceDir: string, devWtPath: string): Promise<void> {
  const wsAbs = resolve(workspaceDir);
  const wtAbs = resolve(devWtPath);
  // Prune stale registrations so a removed-dir doesn't block the add.
  await exec('git', ['worktree', 'prune'], { cwd: wsAbs });
  const all = await listWorktrees(wsAbs);
  const existing = all.find((w) => normalize(w.path) === normalize(wtAbs));
  if (existing) {
    // Detached HEAD (our normal creation mode) or on 'dev' (if the main
    // checkout happens to be on a different branch at creation time) — both OK.
    if (existing.branch !== null && existing.branch !== 'dev') {
      throw new Error(
        `dev merge worktree at ${wtAbs} is on branch "${existing.branch}", expected detached HEAD or "dev" — remove and retry`,
      );
    }
    return; // already in a good state
  }
  // Create in detached HEAD at dev's current commit. --detach works even when
  // the main checkout is already on dev (avoids "already used by worktree" error).
  await exec('git', ['worktree', 'add', '--detach', wtAbs, 'dev'], { cwd: wsAbs });
}

/**
 * Read the current branch name and tree cleanliness of the worktree at
 * `wtPath`. Used as a pre-merge guard: the dev merge worktree must be on
 * `dev` with no uncommitted changes before `git merge` is invoked.
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
