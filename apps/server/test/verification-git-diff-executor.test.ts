// Slice 014a — the hasGitDiff predicate executor: detects a dirty tree
// (tracked/untracked) and reports clean correctly.

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

test('hasGitDiff: false on a clean repo, true once a file is added', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-gitdiff-'));
  try {
    git(dir, 'init');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'hello');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'init');

    const exec = createWorktreeExecutors({ worktreeDir: dir, projectFolderPath: dir });

    // clean
    assert.equal(await exec.hasGitDiff!('worktree'), false);

    // untracked file → dirty
    writeFileSync(join(dir, 'b.txt'), 'new');
    assert.equal(await exec.hasGitDiff!('worktree'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
