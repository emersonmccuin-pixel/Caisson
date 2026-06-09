// pc-pty-chat-270 Chunk A — runtime git primitive tests.
//
// Verifies `gitMergeState`, `mergeBranchIntoDev`, and `pushBranch` against a
// throwaway temp git repo without touching the real project repository.
//
// Test coverage:
// - State before any merge: alreadyMerged=false, mergeInProgress=false, pushed=false
// - Clean merge: mergeBranchIntoDev succeeds; gitMergeState reports alreadyMerged=true
// - Already-merged idempotency: mergeState after merge correctly reports true, not false
// - Conflicting merge: throws; MERGE_HEAD is present → mergeInProgress=true; abort → false
// - Push + pushed state: after pushBranch, gitMergeState reports pushed=true

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureDevWorktree,
  getWorktreeStatus,
  gitMergeState,
  mergeBranchIntoDev,
  pushBranch,
} from '../src/worktree.ts';

let repoDir: string;
let originDir: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
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
  const state = await gitMergeState(repoDir, 'feature-clean');
  assert.equal(state.alreadyMerged, false, 'not yet merged');
  assert.equal(state.mergeInProgress, false, 'no merge in progress');
  assert.equal(state.pushed, false, 'not pushed yet');
});

test('mergeBranchIntoDev: clean merge succeeds', async () => {
  await assert.doesNotReject(
    () => mergeBranchIntoDev(repoDir, 'feature-clean'),
    'clean merge must not throw',
  );
});

test('gitMergeState: alreadyMerged=true after clean merge', async () => {
  const state = await gitMergeState(repoDir, 'feature-clean');
  assert.equal(state.alreadyMerged, true, 'branch tip is now an ancestor of dev');
  assert.equal(state.mergeInProgress, false, 'no lingering MERGE_HEAD');
});

test('mergeBranchIntoDev: conflicting merge throws', async () => {
  await assert.rejects(
    () => mergeBranchIntoDev(repoDir, 'feature-conflict'),
    'conflicting merge must throw',
  );
});

test('gitMergeState: mergeInProgress=true during a conflict', async () => {
  const state = await gitMergeState(repoDir, 'feature-conflict');
  assert.equal(state.mergeInProgress, true, 'MERGE_HEAD must be present after conflict');
  assert.equal(state.alreadyMerged, false, 'conflicted branch is not yet merged');
});

test('gitMergeState: mergeInProgress=false after aborting the conflict', async () => {
  git('merge', '--abort');
  const state = await gitMergeState(repoDir, 'feature-conflict');
  assert.equal(state.mergeInProgress, false, 'MERGE_HEAD must be gone after abort');
});

test('pushBranch + gitMergeState: pushed=true after push', async () => {
  await pushBranch(repoDir, 'dev');
  const state = await gitMergeState(repoDir, 'feature-clean');
  assert.equal(state.pushed, true, 'origin/dev should match local dev after push');
});

// ── ensureDevWorktree ────────────────────────────────────────────────────────

let devWtDir: string;

test('ensureDevWorktree: creates a detached-HEAD worktree at dev commit', async () => {
  devWtDir = mkdtempSync(join(tmpdir(), 'pc-dev-wt-'));
  const devWtPath = join(devWtDir, 'dev-merge');

  await assert.doesNotReject(
    () => ensureDevWorktree(repoDir, devWtPath),
    'ensureDevWorktree must not throw for a clean creation',
  );

  // Worktree is created with --detach so it works even when the main checkout
  // is already on dev. Branch is null (detached HEAD); tree is clean.
  const status = await getWorktreeStatus(devWtPath);
  assert.equal(status.branch, null, 'dev worktree is in detached HEAD (--detach mode)');
  assert.equal(status.clean, true, 'freshly created dev worktree must be clean');
});

test('ensureDevWorktree: idempotent — calling twice with detached worktree does not error', async () => {
  const devWtPath = join(devWtDir, 'dev-merge');
  await assert.doesNotReject(
    () => ensureDevWorktree(repoDir, devWtPath),
    'second call must be a no-op when worktree already exists in detached HEAD',
  );
});

// ── getWorktreeStatus ────────────────────────────────────────────────────────

test('getWorktreeStatus: returns branch=dev and clean=true on the main repo', async () => {
  const status = await getWorktreeStatus(repoDir);
  assert.equal(status.branch, 'dev', 'main repo is on dev');
  assert.equal(status.clean, true, 'main repo is clean (no pending changes)');
});
