// pc-pty-chat-270 Chunk A — WorktreeService merge/push wrappers.
// pc-pty-chat-270.3 — merge-worktree isolation + precondition guards.
//
// Verifies that `mergeBranchIntoIntegration`, `pushIntegration`, and
// `mergeState` on the service delegate to the injected dep functions AND
// always use the engine-controlled merge worktree path (not the user's main
// workspaceDir). Also covers the pre-merge guards: wrong branch / dirty tree
// → throws, no merge attempted. The integration branch comes from the
// injected resolver — nothing assumes the literal 'dev'.

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
// The engine-controlled merge worktree path (what the service computes
// internally as `resolve(baseDir, '__dev-merge')` — historical dir name).
const MERGE_WT_PATH = resolve(FAKE_BASE, '__dev-merge');

const DEV = async () => 'dev';

// Helpers so tests don't spam the same no-op boilerplate.
const noOpList = async (): Promise<WorktreeEntry[]> => [{ path: FAKE_WORKSPACE, branch: 'dev', head: 'abc' }];
const noOpEnsureMerge = async (): Promise<void> => {};
const happyStatus = async (): Promise<{ branch: string | null; clean: boolean }> => ({
  branch: 'dev',
  clean: true,
});

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── mergeBranchIntoIntegration — isolation ───────────────────────────────────

test('mergeBranchIntoIntegration: delegates to dep with the merge worktree path (NOT workspaceDir)', async () => {
  const calls: Array<{ ws: string; branch: string }> = [];

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: noOpList,
    ensureMergeWorktree: noOpEnsureMerge,
    getWorktreeStatus: happyStatus,
    mergeBranchIntoHead: async (ws, branch) => { calls.push({ ws, branch }); },
  });

  await svc.mergeBranchIntoIntegration('wf-TESTABC');

  assert.equal(calls.length, 1, 'dep called exactly once');
  assert.equal(calls[0]!.ws, MERGE_WT_PATH, 'passes merge worktree path, not workspaceDir');
  assert.notEqual(calls[0]!.ws, FAKE_WORKSPACE, 'must NOT pass the user main working tree');
  assert.equal(calls[0]!.branch, 'wf-TESTABC', 'passes branch name');
});

test('mergeBranchIntoIntegration: propagates errors from the dep', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: noOpList,
    ensureMergeWorktree: noOpEnsureMerge,
    getWorktreeStatus: happyStatus,
    mergeBranchIntoHead: async () => { throw new Error('merge conflict'); },
  });

  await assert.rejects(
    () => svc.mergeBranchIntoIntegration('wf-CONFLICT'),
    /merge conflict/,
  );
});

// ── mergeBranchIntoIntegration — pre-merge guards ────────────────────────────

test('guard fires when worktree is on a wrong branch → throws, merge not attempted', async () => {
  let mergeCalled = false;
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: noOpList,
    ensureMergeWorktree: noOpEnsureMerge,
    getWorktreeStatus: async () => ({ branch: 'main', clean: true }), // wrong branch
    mergeBranchIntoHead: async () => { mergeCalled = true; },
  });

  await assert.rejects(
    () => svc.mergeBranchIntoIntegration('wf-GUARDED'),
    /MERGE GUARD.*main/,
    'should throw with a MERGE GUARD message naming the wrong branch',
  );
  assert.ok(!mergeCalled, 'merge dep must NOT be called when the guard fires');
});

test('guard fires when worktree tree is dirty → throws, merge not attempted', async () => {
  let mergeCalled = false;
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: noOpList,
    ensureMergeWorktree: noOpEnsureMerge,
    getWorktreeStatus: async () => ({ branch: 'dev', clean: false }), // dirty tree
    mergeBranchIntoHead: async () => { mergeCalled = true; },
  });

  await assert.rejects(
    () => svc.mergeBranchIntoIntegration('wf-DIRTY'),
    /MERGE GUARD.*uncommitted/,
    'should throw with a MERGE GUARD message about uncommitted changes',
  );
  assert.ok(!mergeCalled, 'merge dep must NOT be called when the guard fires');
});

test('detached HEAD (branch: null) is valid — guard does not fire, merge proceeds', async () => {
  // The merge worktree is normally in detached HEAD state (--detach).
  // Guard must NOT fire for detached HEAD.
  let mergeCalled = false;
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: noOpList,
    ensureMergeWorktree: noOpEnsureMerge,
    getWorktreeStatus: async () => ({ branch: null, clean: true }), // detached HEAD
    mergeBranchIntoHead: async () => { mergeCalled = true; },
  });

  await assert.doesNotReject(
    () => svc.mergeBranchIntoIntegration('wf-DETACHED'),
    'detached HEAD is the normal merge worktree state — must not throw',
  );
  assert.ok(mergeCalled, 'merge dep must be called for a valid detached HEAD worktree');
});

test('non-dev integration branch: guard accepts the configured branch, rejects dev', async () => {
  // Proves the guard compares against the RESOLVED integration branch, not a
  // hardcoded 'dev'. With integration=trunk, a worktree on 'dev' is WRONG.
  let mergeCalled = false;
  const TRUNK = async () => 'trunk';
  const onTrunk = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, TRUNK, {
    listWorktrees: noOpList,
    ensureMergeWorktree: noOpEnsureMerge,
    getWorktreeStatus: async () => ({ branch: 'trunk', clean: true }),
    mergeBranchIntoHead: async () => { mergeCalled = true; },
  });
  await assert.doesNotReject(() => onTrunk.mergeBranchIntoIntegration('wf-X'));
  assert.ok(mergeCalled, 'tracking the configured integration branch is valid');

  const onDev = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, TRUNK, {
    listWorktrees: noOpList,
    ensureMergeWorktree: noOpEnsureMerge,
    getWorktreeStatus: async () => ({ branch: 'dev', clean: true }),
    mergeBranchIntoHead: async () => {},
  });
  await assert.rejects(
    () => onDev.mergeBranchIntoIntegration('wf-X'),
    /MERGE GUARD.*"dev".*"trunk"/s,
    'a worktree on dev is WRONG when the integration branch is trunk',
  );
});

// ── pushIntegration — isolation ──────────────────────────────────────────────

test('pushIntegration: delegates to pushBranch dep with the merge worktree path (NOT workspaceDir)', async () => {
  const calls: Array<{ ws: string; ref: string }> = [];

  // When getWorktreeStatus returns branch:'dev', pushIntegration should use
  // 'dev' as the refspec (branch-tracking worktree mode).
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: noOpList,
    ensureMergeWorktree: noOpEnsureMerge,
    getWorktreeStatus: happyStatus, // returns branch:'dev'
    pushBranch: async (ws, ref) => { calls.push({ ws, ref }); },
  });

  await svc.pushIntegration();

  assert.equal(calls.length, 1, 'dep called exactly once');
  assert.equal(calls[0]!.ws, MERGE_WT_PATH, 'passes merge worktree path, not workspaceDir');
  assert.notEqual(calls[0]!.ws, FAKE_WORKSPACE, 'must NOT pass the user main working tree');
  assert.equal(calls[0]!.ref, 'dev', 'branch-tracking mode uses the branch refspec');
});

test('pushIntegration: detached HEAD mode uses HEAD:<integration> refspec', async () => {
  const calls: Array<{ ws: string; ref: string }> = [];

  // When getWorktreeStatus returns branch:null (detached HEAD — our standard
  // merge worktree mode), pushIntegration must use 'HEAD:<integration>' to
  // push the merge commit (not a stale local branch pointer). Use a non-dev
  // integration branch to prove the refspec is built from the resolver.
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, async () => 'trunk', {
    listWorktrees: noOpList,
    ensureMergeWorktree: noOpEnsureMerge,
    getWorktreeStatus: async () => ({ branch: null, clean: true }), // detached HEAD
    pushBranch: async (ws, ref) => { calls.push({ ws, ref }); },
  });

  await svc.pushIntegration();

  assert.equal(calls.length, 1, 'dep called exactly once');
  assert.equal(calls[0]!.ws, MERGE_WT_PATH, 'passes merge worktree path');
  assert.equal(calls[0]!.ref, 'HEAD:trunk', 'detached mode uses HEAD:<integration> refspec');
});

test('pushIntegration: propagates errors from the dep', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: noOpList,
    ensureMergeWorktree: noOpEnsureMerge,
    getWorktreeStatus: happyStatus,
    pushBranch: async () => { throw new Error('push rejected'); },
  });

  await assert.rejects(() => svc.pushIntegration(), /push rejected/);
});

// ── mergeState — isolation ────────────────────────────────────────────────────

test('mergeState: delegates to gitMergeState dep with the merge worktree path + integration branch', async () => {
  const fakeState: GitMergeState = { alreadyMerged: true, mergeInProgress: false, pushed: false };
  const calls: Array<{ ws: string; branch: string; integration: string }> = [];

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: noOpList,
    ensureMergeWorktree: noOpEnsureMerge,
    gitMergeState: async (ws, branch, integration) => {
      calls.push({ ws, branch, integration });
      return fakeState;
    },
  });

  const result = await svc.mergeState('wf-DONE');

  assert.equal(calls.length, 1, 'dep called exactly once');
  assert.equal(calls[0]!.ws, MERGE_WT_PATH, 'passes merge worktree path, not workspaceDir');
  assert.notEqual(calls[0]!.ws, FAKE_WORKSPACE, 'must NOT pass the user main working tree');
  assert.equal(calls[0]!.branch, 'wf-DONE', 'passes branch name');
  assert.equal(calls[0]!.integration, 'dev', 'passes the resolved integration branch');
  assert.deepEqual(result, fakeState, 'returns the dep result unchanged');
});

test('mergeState: returns all-false state for an unmapped branch', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: noOpList,
    ensureMergeWorktree: noOpEnsureMerge,
    gitMergeState: async () => ({ alreadyMerged: false, mergeInProgress: false, pushed: false }),
  });

  const state = await svc.mergeState('wf-UNKNOWN');
  assert.equal(state.alreadyMerged, false);
  assert.equal(state.mergeInProgress, false);
  assert.equal(state.pushed, false);
});
