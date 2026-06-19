// Worktree teardown + sweep contract tests.
//
// teardownAfterMerge(): the merge node's post-landing cleanup — refuses on
// unmerged branches, removes worktree + branch when merged, tolerates an
// already-missing worktree dir.
//
// sweepStale(): the boot + periodic backstop — reaps merged run worktrees,
// merged orphan branches, and unregistered husk dirs; never touches in-use
// paths, unmerged branches, or unknown dir names. Every keep carries a reason;
// every removal failure lands in `failed` (positive receipt — the 2026-06-11
// incident was 4 lock-failed removals reported as silent keeps).

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

const DEV = async () => 'dev';

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
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    branchMergedInto: async () => false,
    destroyWorktree: async (_ws, p) => { destroyed.push(p); },
    deleteBranch: async (_ws, b) => { deleted.push(b); },
    listWorktrees: async () => [MAIN],
  });

  await assert.rejects(() => svc.teardownAfterMerge('agent-x1'), /TEARDOWN GUARD/);
  assert.equal(destroyed.length, 0, 'worktree must not be destroyed');
  assert.equal(deleted.length, 0, 'branch must not be deleted');
});

test('teardown: guard names the project integration branch, not dev', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, async () => 'trunk', {
    branchMergedInto: async () => false,
    listWorktrees: async () => [MAIN],
  });

  await assert.rejects(
    () => svc.teardownAfterMerge('agent-x1'),
    /TEARDOWN GUARD.*"trunk"/s,
    'guard message must name the resolved integration branch',
  );
});

test('teardown: merged check receives the resolved integration branch', async () => {
  const checks: Array<{ branch: string; integration: string }> = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, async () => 'trunk', {
    branchMergedInto: async (_ws, branch, integration) => {
      checks.push({ branch, integration });
      return true;
    },
    destroyWorktree: async () => {},
    deleteBranch: async () => {},
    listWorktrees: async () => [MAIN],
  });

  await svc.teardownAfterMerge('agent-t1');
  assert.deepEqual(checks, [{ branch: 'agent-t1', integration: 'trunk' }]);
});

test('teardown: merged → worktree force-removed, then branch deleted', async () => {
  const calls: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    branchMergedInto: async () => true,
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
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    branchMergedInto: async () => true,
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
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    branchMergedInto: async () => true,
    destroyWorktree: async () => { throw new Error('EBUSY: resource locked'); },
    deleteBranch: async (_ws, b) => { deleted.push(b); },
    listWorktrees: async () => [MAIN],
  });

  await assert.rejects(() => svc.teardownAfterMerge('agent-x4'), /EBUSY/);
  assert.equal(deleted.length, 0, 'branch must survive a failed worktree removal');
});

// ── sweepStale() ──────────────────────────────────────────────────────────────

test('sweep: merged+idle reaped · in-use kept · unmerged kept — each with its reason', async () => {
  const destroyed: string[] = [];
  const merged = new Set(['agent-done', 'agent-busy']);
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [
      MAIN,
      entry('agent-done'),   // merged, idle → reap
      entry('agent-busy'),   // merged but referenced by a live run → keep
      entry('agent-fresh'),  // unmerged work → keep
    ],
    branchMergedInto: async (_ws, b) => merged.has(b),
    destroyWorktree: async (_ws, p) => { destroyed.push(p); },
    deleteBranch: async () => {},
    listBranchesByPrefix: async () => [],
    listBaseDirNames: async () => [],
  });

  const r = await svc.sweepStale([join(FAKE_BASE, 'agent-busy')]);
  assert.deepEqual(r.removedWorktrees, ['agent-done']);
  assert.deepEqual(destroyed, [join(FAKE_BASE, 'agent-done')]);
  assert.deepEqual(
    [...r.kept].sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'agent-busy', reason: 'in-use' },
      { name: 'agent-fresh', reason: 'unmerged' },
    ],
  );
  assert.deepEqual(r.failed, [], 'no failures in the happy path');
});

test('sweep: merged check uses the configured integration branch', async () => {
  const checks: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, async () => 'reporting-rebuild-phase2', {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [MAIN, entry('agent-q')],
    branchMergedInto: async (_ws, _b, integration) => {
      checks.push(integration);
      return true;
    },
    destroyWorktree: async () => {},
    deleteBranch: async () => {},
    listBranchesByPrefix: async () => [],
    listBaseDirNames: async () => [],
  });

  const r = await svc.sweepStale([]);
  assert.deepEqual(r.removedWorktrees, ['agent-q']);
  assert.ok(checks.length > 0);
  assert.ok(
    checks.every((c) => c === 'reporting-rebuild-phase2'),
    'every merged-check must use the configured integration branch',
  );
});

test('sweep: destroy failure is RECORDED in failed, not a silent keep', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [MAIN, entry('agent-locked')],
    branchMergedInto: async () => true,
    destroyWorktree: async () => { throw new Error('EBUSY: locked by another process'); },
    deleteBranch: async () => {},
    listBranchesByPrefix: async () => [],
    listBaseDirNames: async () => [],
  });

  const r = await svc.sweepStale([]);
  assert.deepEqual(r.removedWorktrees, []);
  assert.deepEqual(r.kept, [], 'a failed removal is NOT a deliberate keep');
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0]!.name, 'agent-locked');
  assert.equal(r.failed[0]!.op, 'worktree-remove');
  assert.match(r.failed[0]!.message, /EBUSY/, 'the real error message is preserved');
});

test('sweep: merged orphan branches deleted; in-use names skipped', async () => {
  const deleted: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [MAIN],
    branchMergedInto: async (_ws, b) => b !== 'wf-unmerged',
    deleteBranch: async (_ws, b) => { deleted.push(b); },
    listBranchesByPrefix: async () => ['agent-orphan', 'wf-unmerged', 'agent-busy'],
    listBaseDirNames: async () => [],
  });

  const r = await svc.sweepStale([join(FAKE_BASE, 'agent-busy')]);
  assert.deepEqual(deleted, ['agent-orphan'], 'only the merged, idle orphan branch goes');
  assert.deepEqual(r.deletedBranches, ['agent-orphan']);
});

test('sweep: unregistered husk dirs removed; non-reapable dirs untouched', async () => {
  const removedDirs: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [MAIN],
    branchMergedInto: async () => false,
    listBranchesByPrefix: async () => [],
    listBaseDirNames: async () => ['agent-husk', 'random-dir'],
    removeDirectory: async (p) => { removedDirs.push(p); },
  });

  const r = await svc.sweepStale([]);
  assert.deepEqual(r.removedHusks, ['agent-husk']);
  assert.deepEqual(removedDirs, [join(FAKE_BASE, 'agent-husk')]);
});

test('sweep: husk removal failure is recorded in failed', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [MAIN],
    branchMergedInto: async () => false,
    listBranchesByPrefix: async () => [],
    listBaseDirNames: async () => ['agent-stuckhusk'],
    removeDirectory: async () => { throw new Error('EPERM: operation not permitted'); },
  });

  const r = await svc.sweepStale([]);
  assert.deepEqual(r.removedHusks, []);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0]!.op, 'husk-remove');
  assert.match(r.failed[0]!.message, /EPERM/);
});

test('sweep: registered survivor is NOT husk-swept even when listed in baseDir', async () => {
  const removedDirs: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [MAIN, entry('agent-fresh')],
    branchMergedInto: async () => false, // unmerged → kept as survivor
    listBranchesByPrefix: async () => [],
    listBaseDirNames: async () => ['agent-fresh'],
    removeDirectory: async (p) => { removedDirs.push(p); },
  });

  const r = await svc.sweepStale([]);
  assert.deepEqual(r.kept, [{ name: 'agent-fresh', reason: 'unmerged' }]);
  assert.deepEqual(removedDirs, [], 'a kept worktree must never be husk-deleted');
});

test('sweep: lock-failed worktree is NOT husk-swept in the same pass', async () => {
  // The destroy threw (dir still on disk, still registered) — the husk pass
  // must not delete it out from under git.
  const removedDirs: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [MAIN, entry('agent-locked')],
    branchMergedInto: async () => true,
    destroyWorktree: async () => { throw new Error('EBUSY'); },
    deleteBranch: async () => {},
    listBranchesByPrefix: async () => [],
    listBaseDirNames: async () => ['agent-locked'],
    removeDirectory: async (p) => { removedDirs.push(p); },
  });

  const r = await svc.sweepStale([]);
  assert.equal(r.failed.length, 1);
  assert.deepEqual(removedDirs, [], 'failed-destroy worktree must survive the husk pass');
});

// ── pc-pty-chat-445 (Fix 2): __dev-merge is reaped by the sweep ──────────────

test('sweep: __dev-merge husk reaped when not in use (pc-pty-chat-445)', async () => {
  // The legacy shared merge worktree name is now in REAPABLE_NAME_RE (exact
  // match). The existing sweep's husk pass collects it; no special boot scan
  // is needed.
  const removedDirs: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [MAIN], // not registered
    branchMergedInto: async () => false,
    listBranchesByPrefix: async () => [],
    listBaseDirNames: async () => ['__dev-merge'],
    removeDirectory: async (p) => { removedDirs.push(p); },
  });

  const r = await svc.sweepStale([]);
  assert.deepEqual(r.removedHusks, ['__dev-merge'], '__dev-merge must be reaped by the husk pass');
  assert.deepEqual(removedDirs, [join(FAKE_BASE, '__dev-merge')]);
});

test('sweep: __dev-merge NOT reaped when in use (guard intact)', async () => {
  // Even though __dev-merge is now reapable by name, the in-use guard must
  // still protect it (e.g. a hypothetical caller that still holds a reference).
  const removedDirs: string[] = [];
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    pruneWorktrees: async () => {},
    listWorktrees: async () => [MAIN],
    branchMergedInto: async () => false,
    listBranchesByPrefix: async () => [],
    listBaseDirNames: async () => ['__dev-merge'],
    removeDirectory: async (p) => { removedDirs.push(p); },
  });

  const r = await svc.sweepStale([join(FAKE_BASE, '__dev-merge')]);
  assert.deepEqual(r.removedHusks, [], '__dev-merge in use must not be reaped');
  assert.deepEqual(removedDirs, []);
});
