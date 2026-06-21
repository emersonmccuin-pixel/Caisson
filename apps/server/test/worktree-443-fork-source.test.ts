// pc-pty-chat-443 — Fix A call-site regression tests.
//
// Test 3: create() calls resolveIntegrationTip WITHOUT a mergeWtPath argument
//   (ensures Fix A is structurally pinned at the call site).
// Test 4: Two sequential dispatches both fork from origin tip, never from a
//   frozen merge-wt SHA (end-to-end stale-fork regression guard).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorktreeEntry } from '@pc/runtime';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-443-fork-'));
process.env['PC_DATA_DIR'] = tmpDir;

const { closeDb, runMigrations } = await import('@pc/db');
const { WorktreeService } = await import('../src/services/worktree.ts');

const FAKE_WORKSPACE = join(tmpDir, 'repo');
const FAKE_BASE = join(tmpDir, 'worktrees', 'proj');
const DEV = async () => 'dev';

const MAIN: WorktreeEntry = { path: FAKE_WORKSPACE, branch: 'dev', head: 'abc' };

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 3: create() calls resolveIntegrationTip WITHOUT mergeWtPath ─────────

test('443-T3: create() calls resolveIntegrationTip with exactly 2 args (no mergeWtPath)', async () => {
  // Record every call to resolveIntegrationTip. After Fix A, the third arg
  // (mergeWtPath) must never be passed from create().
  const calls: Array<{ workspaceDir: string; integration: string; mergeWtPath: string | undefined }> = [];
  const ORIGIN_TIP = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: async () => [MAIN],
    pruneWorktrees: async () => {},
    getWorktreeStatus: async () => ({ branch: 'dev', clean: true }),
    resolveIntegrationTip: async (workspaceDir, integration, mergeWtPath) => {
      calls.push({ workspaceDir, integration, mergeWtPath });
      return ORIGIN_TIP;
    },
    createWorktree: async (_ws, path, name, startPoint) => ({ path, branch: name, head: startPoint ?? '' }),
    installRunner: async () => {},
  });

  await svc.create('agent-443-T3');

  assert.equal(calls.length, 1, 'resolveIntegrationTip must be called exactly once in create()');
  assert.equal(calls[0]!.mergeWtPath, undefined,
    '443-T3: create() must NOT pass a mergeWtPath (Fix A: third arg must be absent)');
  assert.equal(calls[0]!.integration, 'dev', 'must pass the integration branch');
});

// ── Test 4: Two sequential dispatches both fork from origin tip ───────────────

test('443-T4: two sequential create() calls both fork from origin tip, never a frozen SHA', async () => {
  // Simulate the stale-fork scenario: a "frozen" SHA that a bad mergeWtPath
  // would have returned. The origin tip is DIFFERENT and that is what both
  // dispatches must use.
  const ORIGIN_TIP = 'fedcba9876543210fedcba9876543210fedcba98';
  const FROZEN_SHA  = 'dead0000beef0000dead0000beef0000dead0000'; // the old stale base
  const startPoints: string[] = [];

  let callCount = 0;
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, DEV, {
    listWorktrees: async () => [MAIN],
    pruneWorktrees: async () => {},
    getWorktreeStatus: async () => ({ branch: 'dev', clean: true }),
    resolveIntegrationTip: async () => {
      // Always return origin tip (no mergeWtPath arg means no stale fallback).
      return ORIGIN_TIP;
    },
    createWorktree: async (_ws, path, name, startPoint) => {
      startPoints.push(startPoint ?? '');
      callCount++;
      return { path, branch: name, head: startPoint ?? '' };
    },
    installRunner: async () => {},
  });

  await svc.create('agent-443-T4-first');
  await svc.create('agent-443-T4-second');

  assert.equal(callCount, 2, 'createWorktree must be called twice');
  assert.equal(startPoints[0], ORIGIN_TIP, '443-T4: first dispatch must fork from origin tip');
  assert.equal(startPoints[1], ORIGIN_TIP, '443-T4: second dispatch must fork from origin tip');
  assert.notEqual(startPoints[0], FROZEN_SHA, '443-T4: first dispatch must NOT use the frozen SHA');
  assert.notEqual(startPoints[1], FROZEN_SHA, '443-T4: second dispatch must NOT use the frozen SHA');
});
