// pc-pty-chat-270 Chunk A — WorktreeService merge/push wrappers.
//
// Verifies that `mergeBranchIntoDev`, `pushDev`, and `mergeState` on the
// service delegate to the injected dep functions (no real git required).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitMergeState, WorktreeEntry } from '@pc/runtime';

// DB setup — upsertWorktree/markWorktreeDestroyed are called as side-effects.
const tmpDir = mkdtempSync(join(tmpdir(), 'pc-merge-svc-'));
process.env['PC_DATA_DIR'] = tmpDir;

const { closeDb, runMigrations } = await import('@pc/db');
const { WorktreeService } = await import('../src/services/worktree.ts');

const FAKE_WORKSPACE = join(tmpDir, 'repo');
const FAKE_BASE = join(tmpDir, 'worktrees', 'proj');

function fakeEntry(name: string): WorktreeEntry {
  return { path: join(FAKE_BASE, name), branch: name, head: 'abc1234' };
}

const noOpList = async () => [{ path: FAKE_WORKSPACE, branch: 'dev', head: 'abc' }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── mergeBranchIntoDev ───────────────────────────────────────────────────────

test('mergeBranchIntoDev: delegates to the injected dep with workspaceDir + branch', async () => {
  const calls: Array<{ ws: string; branch: string }> = [];

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    mergeBranchIntoDev: async (ws, branch) => { calls.push({ ws, branch }); },
  });

  await svc.mergeBranchIntoDev('wf-TESTABC');

  assert.equal(calls.length, 1, 'dep called exactly once');
  assert.equal(calls[0]!.ws, FAKE_WORKSPACE, 'passes workspaceDir');
  assert.equal(calls[0]!.branch, 'wf-TESTABC', 'passes branch name');
});

test('mergeBranchIntoDev: propagates errors from the dep', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    mergeBranchIntoDev: async () => { throw new Error('merge conflict'); },
  });

  await assert.rejects(
    () => svc.mergeBranchIntoDev('wf-CONFLICT'),
    /merge conflict/,
  );
});

// ── pushDev ──────────────────────────────────────────────────────────────────

test('pushDev: delegates to pushBranch dep with workspaceDir and "dev"', async () => {
  const calls: Array<{ ws: string; ref: string }> = [];

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    pushBranch: async (ws, ref) => { calls.push({ ws, ref }); },
  });

  await svc.pushDev();

  assert.equal(calls.length, 1, 'dep called exactly once');
  assert.equal(calls[0]!.ws, FAKE_WORKSPACE, 'passes workspaceDir');
  assert.equal(calls[0]!.ref, 'dev', 'always pushes "dev"');
});

test('pushDev: propagates errors from the dep', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    pushBranch: async () => { throw new Error('push rejected'); },
  });

  await assert.rejects(() => svc.pushDev(), /push rejected/);
});

// ── mergeState ────────────────────────────────────────────────────────────────

test('mergeState: delegates to gitMergeState dep and returns its result', async () => {
  const fakeState: GitMergeState = { alreadyMerged: true, mergeInProgress: false, pushed: false };
  const calls: Array<{ ws: string; branch: string }> = [];

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    gitMergeState: async (ws, branch) => { calls.push({ ws, branch }); return fakeState; },
  });

  const result = await svc.mergeState('wf-DONE');

  assert.equal(calls.length, 1, 'dep called exactly once');
  assert.equal(calls[0]!.ws, FAKE_WORKSPACE, 'passes workspaceDir');
  assert.equal(calls[0]!.branch, 'wf-DONE', 'passes branch name');
  assert.deepEqual(result, fakeState, 'returns the dep result unchanged');
});

test('mergeState: returns all-false state for an unmapped branch', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    gitMergeState: async () => ({ alreadyMerged: false, mergeInProgress: false, pushed: false }),
  });

  const state = await svc.mergeState('wf-UNKNOWN');
  assert.equal(state.alreadyMerged, false);
  assert.equal(state.mergeInProgress, false);
  assert.equal(state.pushed, false);
});
