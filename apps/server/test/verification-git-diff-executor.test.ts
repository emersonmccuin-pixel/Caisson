// Slice 014a — the hasGitDiff predicate executor.
//
// After pc-pty-chat-281: the executor checks COMMITTED changes vs the
// provisioning base branch (dev/main/master) for worktree dispatches, not
// working-tree dirtiness. A clean working tree with real commits PASSES;
// an uncommitted dirty tree with no commits does NOT pass.

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
