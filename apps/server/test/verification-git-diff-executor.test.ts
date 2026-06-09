// Slice 014a — the hasGitDiff predicate executor.
//
// pc-pty-chat-207 / pc-pty-chat-281: the executor checks COMMITTED changes vs
// the provisioning base branch (dev/main/master) for worktree dispatches, not
// working-tree dirtiness. A clean working tree with real commits PASSES;
// an uncommitted dirty tree with no commits does NOT pass.
//
// pc-pty-chat-207 is the authoritative bug report; 281 was its detection ticket.
// Both describe the same root cause: git_diff_nonempty ran `git status --porcelain`
// (working-tree check) instead of `git rev-list <base>..HEAD` (committed-change
// check). A coder agent that commits correctly and leaves a clean tree would
// false-fail every repo verification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorktreeExecutors } from '../src/services/agent-verification.ts';

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** Set up a repo with a 'dev' base branch + a worktree-style branch. */
function setupRepo(dir: string): void {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'base content');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'base: initial commit');
  // Create 'dev' branch at this same commit (the provisioning base)
  git(dir, 'branch', 'dev');
  // Check out a worktree-style branch (simulates git worktree add -b <name>)
  git(dir, 'checkout', '-b', 'agent-test');
}

test('hasGitDiff (281 fix): committed diff vs base PASSES even when working tree is clean', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-gitdiff-committed-'));
  try {
    setupRepo(dir);

    // Make a commit on the worktree branch — working tree is clean afterwards
    writeFileSync(join(dir, 'feature.ts'), 'export const x = 1;');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'feat: implement feature');
    // Working tree is NOW CLEAN. Old behavior: would return false (no WC changes).
    // New behavior: returns true (1 committed change vs dev).

    const exec = createWorktreeExecutors({ worktreeDir: dir, projectFolderPath: dir });
    assert.equal(
      await exec.hasGitDiff!('worktree'),
      true,
      'committed diff vs base must pass even when working tree is clean',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasGitDiff: false when worktree branch has NO commits vs base', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-gitdiff-nodiff-'));
  try {
    setupRepo(dir);
    // No commits added yet — branch is at the same HEAD as dev

    const exec = createWorktreeExecutors({ worktreeDir: dir, projectFolderPath: dir });
    assert.equal(
      await exec.hasGitDiff!('worktree'),
      false,
      'worktree branch at same commit as base must report no changes',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasGitDiff: true after committing; working-tree dirtiness alone does NOT drive the result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-gitdiff-wt-'));
  try {
    setupRepo(dir);

    const exec = createWorktreeExecutors({ worktreeDir: dir, projectFolderPath: dir });

    // Dirty working tree with no commit → should still be false
    writeFileSync(join(dir, 'b.txt'), 'uncommitted');
    assert.equal(
      await exec.hasGitDiff!('worktree'),
      false,
      'working-tree dirtiness alone must not pass the committed-diff check',
    );

    // Commit the file → now there IS a committed diff vs dev
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'add b.txt');
    assert.equal(
      await exec.hasGitDiff!('worktree'),
      true,
      'committed diff vs base must be detected',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// pc-pty-chat-207 regression: a repo contract on a worktree branch that has
// committed work must PASS git_diff_nonempty — a clean working tree is NOT a
// failure. This is the canonical regression guard for the bug: "well-behaved
// coder agent commits cleanly → predicate false-fails."
test('pc-pty-chat-207 regression: repo worktree with commits passes even with spotless working tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-207-regression-'));
  try {
    setupRepo(dir);

    // Simulate a coder agent: make changes, commit them, leave clean tree.
    writeFileSync(join(dir, 'fix.ts'), 'export const fixed = true;');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'fix: implement the thing (pc-pty-chat-207)');
    // Ensure working tree is genuinely clean
    // (no staged or unstaged changes — just like a well-behaved agent would leave it)

    const exec = createWorktreeExecutors({ worktreeDir: dir, projectFolderPath: dir });
    const result = await exec.hasGitDiff!('worktree');
    assert.equal(
      result,
      true,
      'committed work on a worktree branch must pass git_diff_nonempty regardless of working-tree state',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── pc-pty-chat-370: runBash returns { exitCode, timedOut } ─────────────────

test('(370) runBash: successful command returns {exitCode:0, timedOut:false}', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-bash-ok-'));
  try {
    const exec = createWorktreeExecutors({ worktreeDir: dir, projectFolderPath: dir });
    const result = await exec.runBash('exit 0', 'worktree');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(370) runBash: non-zero exit returns {timedOut:false}', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-bash-fail-'));
  try {
    const exec = createWorktreeExecutors({ worktreeDir: dir, projectFolderPath: dir });
    const result = await exec.runBash('exit 1', 'worktree');
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, false, 'genuine failure must have timedOut:false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(370) runBash: SIGKILLed at timeout returns {exitCode:124, timedOut:true}', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-bash-timeout-'));
  try {
    // bashTimeoutMs of 50ms to keep the test fast; node -e "setTimeout()" is
    // cross-platform (works on Windows and Linux without a `sleep` binary).
    const exec = createWorktreeExecutors({
      worktreeDir: dir,
      projectFolderPath: dir,
      bashTimeoutMs: 50,
    });
    const result = await exec.runBash('node -e "setTimeout(()=>{},10000)"', 'worktree');
    assert.equal(result.timedOut, true, 'must be timedOut when killed by the executor timeout');
    assert.equal(result.exitCode, 124, 'exit code 124 mirrors GNU timeout convention');
  } finally {
    // On Windows a SIGKILL'd node subprocess may not release the directory
    // handle immediately — swallow EBUSY rather than failing the test.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('(370) runBash: per-predicate timeoutMs overrides the executor default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-bash-per-pred-'));
  try {
    // Large default timeout; but the per-call timeoutMs of 50ms fires first.
    const exec = createWorktreeExecutors({
      worktreeDir: dir,
      projectFolderPath: dir,
      bashTimeoutMs: 30_000,
    });
    const result = await exec.runBash('node -e "setTimeout(()=>{},10000)"', 'worktree', 50);
    assert.equal(result.timedOut, true, 'per-call timeoutMs must override the executor default');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// pc-pty-chat-207 in_place: for in_place isolation the fallback is working-tree
// dirtiness (committed-only detection requires a stored pre-dispatch HEAD).
// An uncommitted dirty tree PASSES in_place; a clean tree does not.
test('pc-pty-chat-207 in_place: uncommitted dirty tree passes; clean tree with commits alone does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-207-inplace-'));
  try {
    setupRepo(dir);

    // Commit something on this branch
    writeFileSync(join(dir, 'edit.ts'), 'export const v = 2;');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'commit on in-place branch');

    const exec = createWorktreeExecutors({ worktreeDir: dir, projectFolderPath: dir });

    // in_place with clean tree → false (falls back to working-tree check)
    assert.equal(
      await exec.hasGitDiff!('project'),
      false,
      'in_place with clean working tree returns false (working-tree check)',
    );

    // in_place with uncommitted edit → true
    writeFileSync(join(dir, 'unsaved.ts'), 'export const pending = true;');
    assert.equal(
      await exec.hasGitDiff!('project'),
      true,
      'in_place with uncommitted change returns true',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
