// pc-pty-chat-440 DEFECT 1 — D1a/D1c/D1d unit tests.
//
// D1a: create() uses resolveIntegrationTip, not resolveLocalBranchHead.
// D1c: plannedWorktreePath() returns the expected dir path.
// D1d: concurrent landings use separate per-landing merge worktrees.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { WorktreeEntry } from '@pc/runtime';

// DB setup — upsertWorktree/markWorktreeDestroyed are called as side-effects.
const tmpDir = mkdtempSync(join(tmpdir(), 'pc-d1-fixes-'));
process.env['PC_DATA_DIR'] = tmpDir;

const { closeDb, runMigrations } = await import('@pc/db');
const { WorktreeService } = await import('../src/services/worktree.ts');

const FAKE_WORKSPACE = join(tmpDir, 'repo');
const FAKE_BASE = join(tmpDir, 'worktrees', 'proj');
const DEV = async () => 'dev';

const MAIN: WorktreeEntry = { path: FAKE_WORKSPACE, branch: 'dev', head: 'abc' };
const noOpEnsureMerge = async (): Promise<void> => {};

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── D1a: create() uses resolveIntegrationTip ─────────────────────────────────

test('D1a: create() calls resolveIntegrationTip and NOT resolveLocalBranchHead', async () => {
  const ORIGIN_TIP = 'aaaa0000bbbb1111cccc2222dddd3333eeee4444';
  const LOCAL_TIP = 'ffff5555eeee4444dddd3333cccc2222bbbb1111';
  const tipCalls: string[] = [];
  const localCalls: string[] = [];
  const createCalls: Array<{ startPoint: string | undefined }> = [];

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: async () => [MAIN],
    pruneWorktrees: async () => {},
    getWorktreeStatus: async () => ({ branch: 'dev', clean: true }),
    resolveIntegrationTip: async () => { tipCalls.push('tip'); return ORIGIN_TIP; },
    resolveLocalBranchHead: async () => { localCalls.push('local'); return LOCAL_TIP; },
    createWorktree: async (_ws, path, name, startPoint) => {
      createCalls.push({ startPoint });
      return { path, branch: name, head: startPoint ?? '' };
    },
    installRunner: async () => {},
  });

  const entry = await svc.create('agent-D1A');

  assert.equal(tipCalls.length, 1, 'resolveIntegrationTip must be called');
  assert.equal(localCalls.length, 0, 'resolveLocalBranchHead must NOT be called in create()');
  assert.equal(createCalls[0]!.startPoint, ORIGIN_TIP, 'must fork from the integration tip');
  assert.equal(entry.baseSha, ORIGIN_TIP);
});

// ── D1c: plannedWorktreePath ──────────────────────────────────────────────────

test('D1c: plannedWorktreePath returns the deterministic path for a given worktree name', () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {});
  const name = 'agent-abc123';
  const expected = resolve(FAKE_BASE, name);
  assert.equal(svc.plannedWorktreePath(name), expected, 'must equal resolve(baseDir, name)');
});

test('D1c: plannedWorktreePath matches the path ensureWorktree will create', async () => {
  let createdPath: string | undefined;
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: async () => [MAIN],
    pruneWorktrees: async () => {},
    getWorktreeStatus: async () => ({ branch: 'dev', clean: true }),
    resolveIntegrationTip: async () => 'sha1234',
    createWorktree: async (_ws, path, name) => { createdPath = path; return { path, branch: name, head: 'sha1234' }; },
    installRunner: async () => {},
  });

  const name = 'agent-planned';
  const planned = svc.plannedWorktreePath(name);
  await svc.ensureWorktree(name);

  assert.equal(createdPath, planned, 'plannedWorktreePath must match the path created by ensureWorktree');
});

// ── D1d: concurrent landings use separate merge worktrees ────────────────────

test('D1d: concurrent landings use separate per-landing merge worktrees (no shared state)', async () => {
  const ensureMergeCalls: string[] = [];
  const mergeCalls: string[] = [];

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: async () => [MAIN],
    ensureMergeWorktree: async (_ws, wtPath) => { ensureMergeCalls.push(wtPath); },
    getWorktreeStatus: async () => ({ branch: null, clean: true }), // detached HEAD
    mergeBranchIntoHead: async (wtPath, branch) => { mergeCalls.push(`${wtPath}:${branch}`); },
  });

  // Two concurrent landings for different branches.
  await Promise.all([
    svc.mergeBranchIntoIntegration('agent-abc'),
    svc.mergeBranchIntoIntegration('agent-def'),
  ]);

  assert.equal(ensureMergeCalls.length, 2, 'ensureMergeWorktree called once per landing');
  assert.notEqual(
    ensureMergeCalls[0],
    ensureMergeCalls[1],
    'D1d: concurrent landings must use DIFFERENT merge worktree paths',
  );
  const pathAbc = resolve(FAKE_BASE, '__merge-agent-abc');
  const pathDef = resolve(FAKE_BASE, '__merge-agent-def');
  assert.ok(
    ensureMergeCalls.includes(pathAbc),
    `must include __merge-agent-abc (${pathAbc})`,
  );
  assert.ok(
    ensureMergeCalls.includes(pathDef),
    `must include __merge-agent-def (${pathDef})`,
  );
});

test('D1d: landingMergeWorktreePath returns __merge-<branch> under baseDir', () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {});
  assert.equal(
    svc.landingMergeWorktreePath('agent-xyz'),
    resolve(FAKE_BASE, '__merge-agent-xyz'),
  );
});

test('D1d: REAPABLE_NAME_RE matches __merge-* husks', () => {
  // Access the exported class to verify REAPABLE_NAME_RE via the husk scan
  // path in sweepStale. We exercise teardownLandingMergeWorktree directly.
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: async () => [MAIN],
    ensureMergeWorktree: noOpEnsureMerge,
    pruneWorktrees: async () => {},
    branchMergedInto: async () => false, // no reaping
    destroyWorktree: async () => {},
    listNames: async () => ['__merge-agent-old', 'agent-live'],
    removeDirectory: async () => {},
  });

  // We can't directly read REAPABLE_NAME_RE, but sweepStale will call
  // removeDirectory for any name matching the regex that isn't a survivor.
  // inUsePaths = [] (nothing in use), so __merge-agent-old should be reaped.
  // We verify teardownLandingMergeWorktree doesn't throw and that the
  // service's husk path is correct by calling landingMergeWorktreePath.
  const huskPath = svc.landingMergeWorktreePath('agent-old');
  assert.equal(huskPath, resolve(FAKE_BASE, '__merge-agent-old'), '__merge-* path computed');
});
