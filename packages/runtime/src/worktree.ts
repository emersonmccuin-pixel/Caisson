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
 */
export async function gitMergeState(
  workspaceDir: string,
  branch: string,
): Promise<GitMergeState> {
  assertBranchName(branch);
  const cwd = resolve(workspaceDir);

  // alreadyMerged: exit 0 = is ancestor; non-zero = not (NOT an error condition)
  let alreadyMerged = false;
  try {
    await exec('git', ['merge-base', '--is-ancestor', branch, 'dev'], { cwd });
    alreadyMerged = true;
  } catch {
    /* non-zero = not an ancestor, or branch unknown — both map to false */
  }

  // mergeInProgress: MERGE_HEAD present ⇒ a merge was started but not committed
  let mergeInProgress = false;
  try {
    await exec('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd });
    mergeInProgress = true;
  } catch {
    /* absent → no merge in progress */
  }

  // pushed: origin/dev resolves to the same SHA as local dev
  let pushed = false;
  try {
    const [localRes, remoteRes] = await Promise.all([
      exec('git', ['rev-parse', 'dev'], { cwd }),
      exec('git', ['rev-parse', 'origin/dev'], { cwd }),
    ]);
    pushed = localRes.stdout.trim() === remoteRes.stdout.trim();
  } catch {
    /* no origin/dev (no remote, or not yet pushed) → false */
  }

  return { alreadyMerged, mergeInProgress, pushed };
}

/**
 * Merge `branch` into the current HEAD (expected: `dev`) with `--no-ff`.
 * Throws on conflict or any other failure. Callers must check `gitMergeState`
 * for idempotency before calling (if `alreadyMerged` is true, skip this).
 */
export async function mergeBranchIntoDev(
  workspaceDir: string,
  branch: string,
): Promise<void> {
  assertBranchName(branch);
  await exec('git', ['merge', '--no-ff', branch], { cwd: resolve(workspaceDir) });
}

/**
 * Push `ref` to `origin`. Typically called with `'dev'` after a verified merge.
 */
export async function pushBranch(workspaceDir: string, ref: string): Promise<void> {
  assertBranchName(ref);
  await exec('git', ['push', 'origin', ref], { cwd: resolve(workspaceDir) });
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
