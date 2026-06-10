// Worktree teardown + boot sweep contract tests.
//
// teardownAfterMerge(): the merge node's post-landing cleanup — refuses on
// unmerged branches, removes worktree + branch when merged, tolerates an
// already-missing worktree dir.
//
// sweepStale(): the boot backstop — reaps merged run worktrees, merged orphan
// branches, and unregistered husk dirs; never touches in-use paths, unmerged
// branches, or non-run dirs (__dev-merge).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorktreeEntry } from '@pc/runtime';

// DB setup — upsertWorktree/markWorktreeDestroyed are called as side-effects.
const tmpDir = mkdtempSync(join(tmpdir(), 'pc-worktree-teardown-'));
process.env['PC_DATA_DIR'] = tmpDir;

const { closeDb, runMigrations } = await import('@pc/db');
const { WorktreeService } = await import('../src/services/worktree.ts');

const FAKE_WORKSPACE = join(tmpDir, 'repo');
const FAKE_BASE = join(tmpDir, 'worktrees', 'test-project');

function entry(name: string): WorktreeEntry {
  return { path: join(FAKE_BASE, name), branch: name, head: 'abc1234' };
}

const MAIN: WorktreeEntry = { path: FAKE_WORKSPACE, branch: 'dev', head: 'abc' };

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── teardownAfterMerge() ──────────────────────────────────────────────────────

test('teardown: refuses when branch is not merged — nothing destroyed', async () => {
  const destroyed: string[] = [];
  const deleted: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    branchMergedIntoDev: async () => false,
    destroyWorktree: async (_ws, p) => { destroyed.push(p); },
    deleteBranch: async (_ws, b) => { deleted.push(b); },
    listWorktrees: async () => [MAIN],
  });

  await assert.rejects(() => svc.teardownAfterMerge('agent-x1'), /TEARDOWN GUARD/);
  assert.equal(destroyed.length, 0, 'worktree must not be destroyed');
  assert.equal(deleted.length, 0, 'branch must not be deleted');
});

test('teardown: merged → worktree force-removed, then branch deleted', async () => {
  const calls: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    branchMergedIntoDev: async () => true,
    destroyWorktree: async (_ws, p, opts) => {
      calls.push(`destroy:${p}:force=${opts?.force === true}`);
    },
    deleteBranch: async (_ws, b) => { calls.push(`branch:${b}`); },
    listWorktrees: async () => [MAIN],
  });

  await svc.teardownAfterMerge('agent-x2');
  assert.deepEqual(calls, [
    `destroy:${join(FAKE_BASE, 'agent-x2')}:force=true`,
    'branch:agent-x2',
  ]);
});

test('teardown: worktree dir already gone → prune + branch still deleted', async () => {
  const calls: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    branchMergedIntoDev: async () => true,
    destroyWorktree: async () => { throw new Error('fatal: ... is not a working tree'); },
    pruneWorktrees: async () => { calls.push('prune'); },
    deleteBranch: async (_ws, b) => { calls.push(`branch:${b}`); },
    listWorktrees: async () => [MAIN],
  });

  await svc.teardownAfterMerge('agent-x3');
  assert.deepEqual(calls, ['prune', 'branch:agent-x3']);
});

test('teardown: unexpected destroy failure propagates — branch survives', async () => {
  const deleted: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    branchMergedIntoDev: async () => true,
    destroyWorktree: async () => { throw new Error('EBUSY: resource locked'); },
    deleteBranch: async (_ws, b) => { deleted.push(b); },
    listWorktrees: async () => [MAIN],
  });

  await assert.rejects(() => svc.teardownAfterMerge('agent-x4'), /EBUSY/);
  assert.equal(deleted.length, 0, 'branch must survive a failed worktree removal');
});

// ── sweepStale() ──────────────────────────────────────────────────────────────

test('sweep: merged+idle reaped · in-use kept · unmerged kept', async () => {
  const destroyed: string[] = [];
  const merged = new Set(['agent-done', 'agent-busy']);
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [
      MAIN,
      entry('agent-done'),   // merged, idle → reap
      entry('agent-busy'),   // merged but referenced by a live run → keep
      entry('agent-fresh'),  // unmerged work → keep
    ],
    branchMergedIntoDev: async (_ws, b) => merged.has(b),
    destroyWorktree: async (_ws, p) => { destroyed.push(p); },
    deleteBranch: async () => {},
    listBranchesByPrefix: async () => [],
    listBaseDirNames: async () => [],
  });

  const r = await svc.sweepStale([join(FAKE_BASE, 'agent-busy')]);
  assert.deepEqual(r.removedWorktrees, ['agent-done']);
  assert.deepEqual(destroyed, [join(FAKE_BASE, 'agent-done')]);
  assert.deepEqual(r.kept.sort(), ['agent-busy', 'agent-fresh']);
});

test('sweep: merged orphan branches deleted; in-use names skipped', async () => {
  const deleted: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [MAIN],
    branchMergedIntoDev: async (_ws, b) => b !== 'wf-unmerged',
    deleteBranch: async (_ws, b) => { deleted.push(b); },
    listBranchesByPrefix: async () => ['agent-orphan', 'wf-unmerged', 'agent-busy'],
    listBaseDirNames: async () => [],
  });

  const r = await svc.sweepStale([join(FAKE_BASE, 'agent-busy')]);
  assert.deepEqual(deleted, ['agent-orphan'], 'only the merged, idle orphan branch goes');
  assert.deepEqual(r.deletedBranches, ['agent-orphan']);
});

test('sweep: unregistered husk dirs removed; non-run dirs untouched', async () => {
  const removedDirs: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [MAIN],
    branchMergedIntoDev: async () => false,
    listBranchesByPrefix: async () => [],
    listBaseDirNames: async () => ['agent-husk', '__dev-merge', 'random-dir'],
    removeDirectory: async (p) => { removedDirs.push(p); },
  });

  const r = await svc.sweepStale([]);
  assert.deepEqual(r.removedHusks, ['agent-husk']);
  assert.deepEqual(removedDirs, [join(FAKE_BASE, 'agent-husk')]);
});

test('sweep: registered survivor is NOT husk-swept even when listed in baseDir', async () => {
  const removedDirs: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [MAIN, entry('agent-fresh')],
    branchMergedIntoDev: async () => false, // unmerged → kept as survivor
    listBranchesByPrefix: async () => [],
    listBaseDirNames: async () => ['agent-fresh'],
    removeDirectory: async (p) => { removedDirs.push(p); },
  });

  const r = await svc.sweepStale([]);
  assert.deepEqual(r.kept, ['agent-fresh']);
  assert.deepEqual(removedDirs, [], 'a kept worktree must never be husk-deleted');
});
