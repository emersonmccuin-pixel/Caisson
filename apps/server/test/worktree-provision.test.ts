// Worktree provisioning contract tests (pc-pty-chat-305).
//
// Verifies that `pnpm install --frozen-lockfile` (via the installRunner seam)
// is awaited and surfaced for BOTH provisioning paths — create() and the
// attach/orphan-recovery branch of ensureWorktree() — without requiring real
// git or pnpm processes.
//
// A fourth test confirms that an *already-attached* worktree (the match
// branch of ensureWorktree) does NOT trigger a redundant reinstall.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorktreeEntry } from '@pc/runtime';

// DB setup — upsertWorktree/markWorktreeDestroyed are called as side-effects.
const tmpDir = mkdtempSync(join(tmpdir(), 'pc-worktree-provision-'));
process.env['PC_DATA_DIR'] = tmpDir;

const { closeDb, runMigrations } = await import('@pc/db');
const { WorktreeService } = await import('../src/services/worktree.ts');

const FAKE_WORKSPACE = join(tmpDir, 'repo');
const FAKE_BASE = join(tmpDir, 'worktrees', 'test-project');

function fakeEntry(name: string): WorktreeEntry {
  return { path: join(FAKE_BASE, name), branch: name, head: 'abc1234' };
}

/** A listWorktrees stub that returns only the main workspace (no sub-trees). */
async function mainOnly(): Promise<WorktreeEntry[]> {
  return [{ path: FAKE_WORKSPACE, branch: 'dev', head: 'abc' }];
}

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── create() path ─────────────────────────────────────────────────────────────

test('provision/create: installRunner is called with the new worktree path', async () => {
  const installed: string[] = [];

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    createWorktree: async (_ws, _path, name) => fakeEntry(name),
    listWorktrees: mainOnly,
    installRunner: async (cwd) => { installed.push(cwd); },
  });

  const entry = await svc.create('agent-abc');

  assert.equal(installed.length, 1, 'installRunner called exactly once');
  assert.equal(installed[0], entry.path, 'installRunner called with the returned entry path');
});

test('provision/create: install failure propagates — caller never gets a half-provisioned entry', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    createWorktree: async (_ws, _path, name) => fakeEntry(name),
    listWorktrees: mainOnly,
    installRunner: async () => {
      throw new Error('pnpm install --frozen-lockfile failed (exit 1) in /some/path:\nERR_LOCKFILE');
    },
  });

  await assert.rejects(
    () => svc.create('agent-fail'),
    /pnpm install.*failed/i,
    'create() must propagate install failure',
  );
});

// ── ensureWorktree() attach/orphan-recovery path ──────────────────────────────

test('provision/attach: installRunner is called when branch already exists (orphan recovery)', async () => {
  const installed: string[] = [];
  const name = 'agent-orphan';

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    pruneWorktrees: async () => {},
    // No match in the initial list → triggers create() attempt.
    listWorktrees: mainOnly,
    // Simulate "branch already exists" to force the attach branch.
    createWorktree: async () => { throw new Error('fatal: already exists'); },
    attachWorktree: async (_ws, _path, n) => fakeEntry(n),
    installRunner: async (cwd) => { installed.push(cwd); },
  });

  const entry = await svc.ensureWorktree(name);

  assert.equal(entry.path, fakeEntry(name).path, 'entry path is correct');
  assert.equal(installed.length, 1, 'installRunner called exactly once');
  assert.equal(installed[0], fakeEntry(name).path, 'installRunner called with the attached worktree path');
});

test('provision/attach: install failure propagates — orphan recovery does not swallow the error', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    pruneWorktrees: async () => {},
    listWorktrees: mainOnly,
    createWorktree: async () => { throw new Error('fatal: already exists'); },
    attachWorktree: async (_ws, _path, n) => fakeEntry(n),
    installRunner: async () => {
      throw new Error('pnpm install --frozen-lockfile failed (exit 1) in /some/path:\nERR_LOCKFILE');
    },
  });

  await assert.rejects(
    () => svc.ensureWorktree('agent-orphan-fail'),
    /pnpm install.*failed/i,
    'ensureWorktree() attach branch must propagate install failure',
  );
});

// ── ensureWorktree() match (already-attached) path ───────────────────────────

test('provision/match: installRunner is NOT called for an already-attached worktree', async () => {
  const installed: string[] = [];
  const name = 'agent-existing';
  const existingEntry = fakeEntry(name);

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, {
    pruneWorktrees: async () => {},
    // Match found in the initial list → short-circuit return, no provision.
    listWorktrees: async () => [
      { path: FAKE_WORKSPACE, branch: 'dev', head: 'abc' },
      existingEntry,
    ],
    installRunner: async (cwd) => { installed.push(cwd); },
  });

  const entry = await svc.ensureWorktree(name);

  assert.equal(entry.path, existingEntry.path, 'returns the existing entry');
  assert.equal(installed.length, 0, 'installRunner must NOT be called for an already-attached worktree');
});
