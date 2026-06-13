// pc-pty-chat-270 Chunk A — runtime git primitive tests.
//
// Verifies `gitMergeState`, `mergeBranchIntoHead`, `pushBranch`,
// `ensureMergeWorktree`, `branchMergedInto`, and `detectIntegrationBranch`
// against throwaway temp git repos without touching the real project repo.
//
// Two fixtures: a `dev`-named integration repo (the historical default) and a
// `trunk`-named one (proves nothing assumes the literal 'dev' anymore).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  branchMergedInto,
  detectIntegrationBranch,
  ensureMergeWorktree,
  getWorktreeStatus,
  gitMergeState,
  mergeBranchIntoHead,
  pushBranch,
} from '../src/worktree.ts';

let repoDir: string;
let originDir: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
}
function gitOut(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir }).toString().trim();
}
function gitOrigin(...args: string[]): void {
  execFileSync('git', args, { cwd: originDir, stdio: 'ignore' });
}

before(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'pc-merge-repo-'));
  originDir = mkdtempSync(join(tmpdir(), 'pc-merge-origin-'));

  // Set up bare "origin"
  gitOrigin('init', '--bare');

  // Set up the main repo
  git('init');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');

  // Initial commit then rename to dev
  writeFileSync(join(repoDir, 'base.txt'), 'base\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  git('branch', '-m', 'dev');

  // Set up origin
  git('remote', 'add', 'origin', originDir);

  // feature-clean: adds a new file (no conflict with dev)
  git('checkout', '-b', 'feature-clean');
  writeFileSync(join(repoDir, 'feature.txt'), 'new feature\n');
  git('add', '.');
  git('commit', '-m', 'add feature.txt');
  git('checkout', 'dev');

  // feature-conflict: modifies shared.txt; dev also modifies it → conflict
  git('checkout', '-b', 'feature-conflict');
  writeFileSync(join(repoDir, 'shared.txt'), 'branch-version\n');
  git('add', '.');
  git('commit', '-m', 'shared.txt on branch');
  git('checkout', 'dev');
  writeFileSync(join(repoDir, 'shared.txt'), 'dev-version\n');
  git('add', '.');
  git('commit', '-m', 'shared.txt on dev');
});

after(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(originDir, { recursive: true, force: true });
});

test('gitMergeState: initial state — not merged, no conflict, not pushed', async () => {
  const state = await gitMergeState(repoDir, 'feature-clean', 'dev');
  assert.equal(state.alreadyMerged, false, 'not yet merged');
  assert.equal(state.mergeInProgress, false, 'no merge in progress');
  assert.equal(state.pushed, false, 'not pushed yet');
});

test('branchMergedInto: false before merge, true after', async () => {
  assert.equal(await branchMergedInto(repoDir, 'feature-clean', 'dev'), false);
});

test('mergeBranchIntoHead: clean merge succeeds', async () => {
  await assert.doesNotReject(
    () => mergeBranchIntoHead(repoDir, 'feature-clean'),
    'clean merge must not throw',
  );
});

test('gitMergeState: alreadyMerged=true after clean merge', async () => {
  const state = await gitMergeState(repoDir, 'feature-clean', 'dev');
  assert.equal(state.alreadyMerged, true, 'branch tip is now an ancestor of dev');
  assert.equal(state.mergeInProgress, false, 'no lingering MERGE_HEAD');
  assert.equal(await branchMergedInto(repoDir, 'feature-clean', 'dev'), true);
});

test('mergeBranchIntoHead: conflicting merge throws', async () => {
  await assert.rejects(
    () => mergeBranchIntoHead(repoDir, 'feature-conflict'),
    'conflicting merge must throw',
  );
});

test('gitMergeState: mergeInProgress=true during a conflict', async () => {
  const state = await gitMergeState(repoDir, 'feature-conflict', 'dev');
  assert.equal(state.mergeInProgress, true, 'MERGE_HEAD must be present after conflict');
  assert.equal(state.alreadyMerged, false, 'conflicted branch is not yet merged');
});

test('gitMergeState: mergeInProgress=false after aborting the conflict', async () => {
  git('merge', '--abort');
  const state = await gitMergeState(repoDir, 'feature-conflict', 'dev');
  assert.equal(state.mergeInProgress, false, 'MERGE_HEAD must be gone after abort');
});

test('pushBranch + gitMergeState: pushed=true after push', async () => {
  await pushBranch(repoDir, 'dev');
  const state = await gitMergeState(repoDir, 'feature-clean', 'dev');
  assert.equal(state.pushed, true, 'origin/dev should match local dev after push');
});

// ── ensureMergeWorktree ──────────────────────────────────────────────────────

let mergeWtDir: string;

test('ensureMergeWorktree: creates a detached-HEAD worktree at the integration tip', async () => {
  mergeWtDir = mkdtempSync(join(tmpdir(), 'pc-merge-wt-'));
  const wtPath = join(mergeWtDir, 'dev-merge');

  await assert.doesNotReject(
    () => ensureMergeWorktree(repoDir, wtPath, 'dev'),
    'ensureMergeWorktree must not throw for a clean creation',
  );

  const status = await getWorktreeStatus(wtPath);
  assert.equal(status.branch, null, 'merge worktree is in detached HEAD (--detach mode)');
  assert.equal(status.clean, true, 'freshly created merge worktree must be clean');
});

test('ensureMergeWorktree: idempotent — reuses an up-to-date detached worktree', async () => {
  const wtPath = join(mergeWtDir, 'dev-merge');
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath })
    .toString()
    .trim();
  await assert.doesNotReject(() => ensureMergeWorktree(repoDir, wtPath, 'dev'));
  const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath })
    .toString()
    .trim();
  assert.equal(headAfter, headBefore, 'up-to-date worktree must be reused, not recreated');
});

test('ensureMergeWorktree: LINEAGE GUARD — stale worktree is recreated at the new tip', async () => {
  const wtPath = join(mergeWtDir, 'dev-merge');
  // Advance dev in the main checkout (an out-of-band merge / commit).
  writeFileSync(join(repoDir, 'advance.txt'), 'moved on\n');
  git('add', '.');
  git('commit', '-m', 'advance dev past the merge worktree');
  const devTip = gitOut('rev-parse', 'dev');

  await ensureMergeWorktree(repoDir, wtPath, 'dev');
  const wtHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath }).toString().trim();
  assert.equal(wtHead, devTip, 'stale worktree must be recreated at the current dev tip');
});

test('ensureMergeWorktree: MERGE_HEAD guard — a parked conflict is never destroyed', async () => {
  const wtPath = join(mergeWtDir, 'dev-merge');
  // Park a conflict inside the merge worktree.
  try {
    execFileSync('git', ['merge', '--no-ff', 'feature-conflict'], { cwd: wtPath, stdio: 'ignore' });
  } catch {
    /* expected: conflict */
  }
  // Advance dev again so the worktree is ALSO stale — conflict must still win.
  writeFileSync(join(repoDir, 'advance2.txt'), 'moved on again\n');
  git('add', '.');
  git('commit', '-m', 'advance dev again');

  await ensureMergeWorktree(repoDir, wtPath, 'dev');
  assert.ok(
    existsSync(join(wtPath, 'shared.txt')),
    'worktree must survive (parked conflict state)',
  );
  const state = await gitMergeState(wtPath, 'feature-conflict', 'dev');
  assert.equal(state.mergeInProgress, true, 'MERGE_HEAD must still be present');
  execFileSync('git', ['merge', '--abort'], { cwd: wtPath, stdio: 'ignore' });
});

// ── non-dev integration branch (proves the literal is gone) ─────────────────

test('integration machinery works on a repo whose integration branch is "trunk"', async () => {
  const repo2 = mkdtempSync(join(tmpdir(), 'pc-trunk-repo-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo2, stdio: 'ignore' });
  try {
    g('init');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo2, 'a.txt'), 'a\n');
    g('add', '.');
    g('commit', '-m', 'initial');
    g('branch', '-m', 'trunk');
    g('checkout', '-b', 'agent-x');
    writeFileSync(join(repo2, 'b.txt'), 'b\n');
    g('add', '.');
    g('commit', '-m', 'work');
    g('checkout', 'trunk');

    assert.equal(await branchMergedInto(repo2, 'agent-x', 'trunk'), false);
    g('merge', '--no-ff', 'agent-x');
    assert.equal(await branchMergedInto(repo2, 'agent-x', 'trunk'), true);

    const state = await gitMergeState(repo2, 'agent-x', 'trunk');
    assert.equal(state.alreadyMerged, true);

    const wt = join(mkdtempSync(join(tmpdir(), 'pc-trunk-wt-')), 'merge');
    await ensureMergeWorktree(repo2, wt, 'trunk');
    const status = await getWorktreeStatus(wt);
    assert.equal(status.branch, null, 'detached at trunk tip');
  } finally {
    rmSync(repo2, { recursive: true, force: true });
  }
});

// ── cherry-pick (patch-equivalence) landing — the CIA-NEXT flow ─────────────

test('branchMergedInto: cherry-picked work counts as landed; un-picked commits do not', async () => {
  const repo3 = mkdtempSync(join(tmpdir(), 'pc-cherry-repo-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo3, stdio: 'ignore' });
  try {
    g('init', '-b', 'phase-branch');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo3, 'a.txt'), 'a\n');
    g('add', '.');
    g('commit', '-m', 'initial');

    // Agent branch with one commit.
    g('checkout', '-b', 'agent-cp');
    writeFileSync(join(repo3, 'work.txt'), 'agent work\n');
    g('add', '.');
    g('commit', '-m', 'agent work');
    const tip = execFileSync('git', ['rev-parse', 'agent-cp'], { cwd: repo3 }).toString().trim();

    // Integrate by CHERRY-PICK (not merge) — tip is NOT an ancestor.
    g('checkout', 'phase-branch');
    g('cherry-pick', tip);

    assert.equal(
      await branchMergedInto(repo3, 'agent-cp', 'phase-branch'),
      true,
      'patch-equivalent (cherry-picked) work is landed — safe to reap',
    );

    // A second commit on the agent branch that was NEVER picked → kept.
    g('checkout', 'agent-cp');
    writeFileSync(join(repo3, 'more.txt'), 'unlanded\n');
    g('add', '.');
    g('commit', '-m', 'unlanded work');
    g('checkout', 'phase-branch');

    assert.equal(
      await branchMergedInto(repo3, 'agent-cp', 'phase-branch'),
      false,
      'any commit without an upstream equivalent keeps the branch',
    );
  } finally {
    rmSync(repo3, { recursive: true, force: true });
  }
});

// ── detectIntegrationBranch ──────────────────────────────────────────────────

test('detectIntegrationBranch: prefers a local dev branch', async () => {
  assert.equal(await detectIntegrationBranch(repoDir), 'dev');
});

test('detectIntegrationBranch: falls back to origin/HEAD, then current branch', async () => {
  const repo2 = mkdtempSync(join(tmpdir(), 'pc-detect-repo-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo2, stdio: 'ignore' });
  try {
    g('init', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo2, 'a.txt'), 'a\n');
    g('add', '.');
    g('commit', '-m', 'initial');

    // No dev, no origin → current branch.
    assert.equal(await detectIntegrationBranch(repo2), 'main');

    // Simulate a clone's origin/HEAD pointing at main while checked out elsewhere.
    g('checkout', '-b', 'work-branch');
    assert.equal(await detectIntegrationBranch(repo2), 'work-branch');
  } finally {
    rmSync(repo2, { recursive: true, force: true });
  }
});

// ── getWorktreeStatus ────────────────────────────────────────────────────────

test('getWorktreeStatus: returns branch=dev and clean=true on the main repo', async () => {
  const status = await getWorktreeStatus(repoDir);
  assert.equal(status.branch, 'dev', 'main repo is on dev');
  assert.equal(status.clean, true, 'main repo is clean (no pending changes)');
});
