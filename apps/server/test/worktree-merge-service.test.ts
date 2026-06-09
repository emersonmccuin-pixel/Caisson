// pc-pty-chat-270 Chunk A — WorktreeService merge/push wrappers.
// pc-pty-chat-270.3 — dev-worktree isolation + precondition guards.
//
// Verifies that `mergeBranchIntoDev`, `pushDev`, and `mergeState` on the
// service delegate to the injected dep functions AND always use the dev
// merge worktree path (not the user's main workspaceDir). Also covers the
// pre-merge guards: wrong branch / dirty tree → throws, no merge attempted.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { GitMergeState, WorktreeEntry } from '@pc/runtime';

// DB setup — upsertWorktree/markWorktreeDestroyed are called as side-effects.
const tmpDir = mkdtempSync(join(tmpdir(), 'pc-merge-svc-'));
process.env['PC_DATA_DIR'] = tmpDir;

const { closeDb, runMigrations } = await import('@pc/db');
const { WorktreeService } = await import('../src/services/worktree.ts');

const FAKE_WORKSPACE = join(tmpDir, 'repo');
const FAKE_BASE = join(tmpDir, 'worktrees', 'proj');
// The engine-controlled dev merge worktree path (what the service computes
// internally as `resolve(baseDir, '__dev-merge')`).
const DEV_WT_PATH = resolve(FAKE_BASE, '__dev-merge');

// Helpers so tests don't spam the same no-op boilerplate.
const noOpList = async (): Promise<WorktreeEntry[]> => [{ path: FAKE_WORKSPACE, branch: 'dev', head: 'abc' }];
const noOpEnsureDev = async (): Promise<void> => {};
const happyStatus = async (): Promise<{ branch: string | null; clean: boolean }> => ({
  branch: 'dev',
  clean: true,
});

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── mergeBranchIntoDev — isolation ───────────────────────────────────────────

test('mergeBranchIntoDev: delegates to dep with the dev worktree path (NOT workspaceDir)', async () => {
  const calls: Array<{ ws: string; branch: string }> = [];

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    ensureDevWorktree: noOpEnsureDev,
    getWorktreeStatus: happyStatus,
    mergeBranchIntoDev: async (ws, branch) => { calls.push({ ws, branch }); },
  });

  await svc.mergeBranchIntoDev('wf-TESTABC');

  assert.equal(calls.length, 1, 'dep called exactly once');
  assert.equal(calls[0]!.ws, DEV_WT_PATH, 'passes dev worktree path, not workspaceDir');
  assert.notEqual(calls[0]!.ws, FAKE_WORKSPACE, 'must NOT pass the user main working tree');
  assert.equal(calls[0]!.branch, 'wf-TESTABC', 'passes branch name');
});

test('mergeBranchIntoDev: propagates errors from the dep', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    ensureDevWorktree: noOpEnsureDev,
    getWorktreeStatus: happyStatus,
    mergeBranchIntoDev: async () => { throw new Error('merge conflict'); },
  });

  await assert.rejects(
    () => svc.mergeBranchIntoDev('wf-CONFLICT'),
    /merge conflict/,
  );
});

// ── mergeBranchIntoDev — pre-merge guards ────────────────────────────────────

test('mergeBranchIntoDev: guard fires when worktree is on a wrong branch → throws, merge not attempted', async () => {
  let mergeCalled = false;
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    ensureDevWorktree: noOpEnsureDev,
    getWorktreeStatus: async () => ({ branch: 'main', clean: true }), // wrong branch
    mergeBranchIntoDev: async () => { mergeCalled = true; },
  });

  await assert.rejects(
    () => svc.mergeBranchIntoDev('wf-GUARDED'),
    /MERGE GUARD.*main/,
    'should throw with a MERGE GUARD message naming the wrong branch',
  );
  assert.ok(!mergeCalled, 'merge dep must NOT be called when the guard fires');
});

test('mergeBranchIntoDev: guard fires when worktree tree is dirty → throws, merge not attempted', async () => {
  let mergeCalled = false;
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    ensureDevWorktree: noOpEnsureDev,
    getWorktreeStatus: async () => ({ branch: 'dev', clean: false }), // dirty tree
    mergeBranchIntoDev: async () => { mergeCalled = true; },
  });

  await assert.rejects(
    () => svc.mergeBranchIntoDev('wf-DIRTY'),
    /MERGE GUARD.*uncommitted/,
    'should throw with a MERGE GUARD message about uncommitted changes',
  );
  assert.ok(!mergeCalled, 'merge dep must NOT be called when the guard fires');
});

test('mergeBranchIntoDev: detached HEAD (branch: null) is valid — guard does not fire, merge proceeds', async () => {
  // The dev merge worktree is normally in detached HEAD state (--detach).
  // Guard must NOT fire for detached HEAD.
  let mergeCalled = false;
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    ensureDevWorktree: noOpEnsureDev,
    getWorktreeStatus: async () => ({ branch: null, clean: true }), // detached HEAD
    mergeBranchIntoDev: async () => { mergeCalled = true; },
  });

  await assert.doesNotReject(
    () => svc.mergeBranchIntoDev('wf-DETACHED'),
    'detached HEAD is the normal dev merge worktree state — must not throw',
  );
  assert.ok(mergeCalled, 'merge dep must be called for a valid detached HEAD worktree');
});

// ── pushDev — isolation ───────────────────────────────────────────────────────

test('pushDev: delegates to pushBranch dep with the dev worktree path (NOT workspaceDir)', async () => {
  const calls: Array<{ ws: string; ref: string }> = [];

  // When getWorktreeStatus returns branch:'dev', pushDev should use 'dev' as
  // the refspec (branch-tracking worktree mode).
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    ensureDevWorktree: noOpEnsureDev,
    getWorktreeStatus: happyStatus, // returns branch:'dev'
    pushBranch: async (ws, ref) => { calls.push({ ws, ref }); },
  });

  await svc.pushDev();

  assert.equal(calls.length, 1, 'dep called exactly once');
  assert.equal(calls[0]!.ws, DEV_WT_PATH, 'passes dev worktree path, not workspaceDir');
  assert.notEqual(calls[0]!.ws, FAKE_WORKSPACE, 'must NOT pass the user main working tree');
  assert.equal(calls[0]!.ref, 'dev', 'branch-tracking mode uses "dev" refspec');
});

test('pushDev: detached HEAD mode uses HEAD:dev refspec', async () => {
  const calls: Array<{ ws: string; ref: string }> = [];

  // When getWorktreeStatus returns branch:null (detached HEAD — our standard
  // dev merge worktree mode), pushDev must use 'HEAD:dev' to push the merge
  // commit (not the stale local 'dev' branch pointer).
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    ensureDevWorktree: noOpEnsureDev,
    getWorktreeStatus: async () => ({ branch: null, clean: true }), // detached HEAD
    pushBranch: async (ws, ref) => { calls.push({ ws, ref }); },
  });

  await svc.pushDev();

  assert.equal(calls.length, 1, 'dep called exactly once');
  assert.equal(calls[0]!.ws, DEV_WT_PATH, 'passes dev worktree path');
  assert.equal(calls[0]!.ref, 'HEAD:dev', 'detached mode uses HEAD:dev refspec');
});

test('pushDev: propagates errors from the dep', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    ensureDevWorktree: noOpEnsureDev,
    getWorktreeStatus: happyStatus,
    pushBranch: async () => { throw new Error('push rejected'); },
  });

  await assert.rejects(() => svc.pushDev(), /push rejected/);
});

// ── mergeState — isolation ────────────────────────────────────────────────────

test('mergeState: delegates to gitMergeState dep with the dev worktree path (NOT workspaceDir)', async () => {
  const fakeState: GitMergeState = { alreadyMerged: true, mergeInProgress: false, pushed: false };
  const calls: Array<{ ws: string; branch: string }> = [];

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    ensureDevWorktree: noOpEnsureDev,
    gitMergeState: async (ws, branch) => { calls.push({ ws, branch }); return fakeState; },
  });

  const result = await svc.mergeState('wf-DONE');

  assert.equal(calls.length, 1, 'dep called exactly once');
  assert.equal(calls[0]!.ws, DEV_WT_PATH, 'passes dev worktree path, not workspaceDir');
  assert.notEqual(calls[0]!.ws, FAKE_WORKSPACE, 'must NOT pass the user main working tree');
  assert.equal(calls[0]!.branch, 'wf-DONE', 'passes branch name');
  assert.deepEqual(result, fakeState, 'returns the dep result unchanged');
});

test('mergeState: returns all-false state for an unmapped branch', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    listWorktrees: noOpList,
    ensureDevWorktree: noOpEnsureDev,
    gitMergeState: async () => ({ alreadyMerged: false, mergeInProgress: false, pushed: false }),
  });

  const state = await svc.mergeState('wf-UNKNOWN');
  assert.equal(state.alreadyMerged, false);
  assert.equal(state.mergeInProgress, false);
  assert.equal(state.pushed, false);
});
