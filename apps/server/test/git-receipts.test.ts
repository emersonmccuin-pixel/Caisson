// pc-pty-chat-415 (R4) — git-receipts probes against a REAL git repo.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { workingTreeStatus, headSha, currentBranch } from '../src/services/git-receipts.ts';

const repo = mkdtempSync(join(tmpdir(), 'pc-git-receipts-'));

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

before(() => {
  git('init', '-b', 'seal-branch');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-m', 'init');
});
after(() => rmSync(repo, { recursive: true, force: true }));

test('clean committed tree → clean + sha + branch', async () => {
  assert.equal(await workingTreeStatus(repo), 'clean');
  const sha = await headSha(repo);
  assert.ok(sha && /^[0-9a-f]{40}$/.test(sha), 'full HEAD sha');
  assert.equal(await currentBranch(repo), 'seal-branch');
});

test('untracked file → dirty; commit → clean again', async () => {
  writeFileSync(join(repo, 'b.txt'), 'two\n');
  assert.equal(await workingTreeStatus(repo), 'dirty', 'untracked counts as dirty');
  git('add', '-A');
  assert.equal(await workingTreeStatus(repo), 'dirty', 'staged counts as dirty');
  git('commit', '-m', 'two');
  assert.equal(await workingTreeStatus(repo), 'clean');
});

test('non-repo directory → unknown (never silently clean)', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'pc-git-receipts-plain-'));
  try {
    assert.equal(await workingTreeStatus(plain), 'unknown');
    assert.equal(await headSha(plain), null);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
