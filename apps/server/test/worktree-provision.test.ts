// Worktree provisioning contract tests (pc-pty-chat-305).
//
// Verifies that the dep install (via the installRunner seam) is awaited and
// surfaced for BOTH provisioning paths — create() and the attach/orphan-
// recovery branch of ensureWorktree() — without requiring real git or
// package-manager processes.
//
// A fourth test confirms that an *already-attached* worktree (the match
// branch of ensureWorktree) is also dependency-checked before reuse.
//
// The detection tests pin the lockfile → install-command mapping and the
// no-lockfile no-op (polyglot / non-Node repos must not fail provisioning).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorktreeEntry } from '@pc/runtime';

// DB setup — upsertWorktree/markWorktreeDestroyed are called as side-effects.
const tmpDir = mkdtempSync(join(tmpdir(), 'pc-worktree-provision-'));
process.env['PC_DATA_DIR'] = tmpDir;

const { closeDb, runMigrations } = await import('@pc/db');
const { WorktreeService, detectInstallCommand, detectInstallSteps, defaultInstallRunner } = await import(
  '../src/services/worktree.ts'
);

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

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, async () => 'dev', {
    createWorktree: async (_ws, _path, name) => fakeEntry(name),
    listWorktrees: mainOnly,
    getWorktreeStatus: async () => ({ branch: 'dev', clean: true }),
    resolveIntegrationTip: async () => 'abc1234',
    installRunner: async (cwd) => { installed.push(cwd); },
  });

  const entry = await svc.create('agent-abc');

  assert.equal(installed.length, 1, 'installRunner called exactly once');
  assert.equal(installed[0], entry.path, 'installRunner called with the returned entry path');
});

test('provision/create: install failure propagates — caller never gets a half-provisioned entry', async () => {
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, async () => 'dev', {
    createWorktree: async (_ws, _path, name) => fakeEntry(name),
    listWorktrees: mainOnly,
    getWorktreeStatus: async () => ({ branch: 'dev', clean: true }),
    resolveIntegrationTip: async () => 'abc1234',
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

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, async () => 'dev', {
    pruneWorktrees: async () => {},
    // No match in the initial list → triggers create() attempt.
    listWorktrees: mainOnly,
    getWorktreeStatus: async () => ({ branch: 'dev', clean: true }),
    resolveIntegrationTip: async () => 'abc1234',
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
  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, async () => 'dev', {
    pruneWorktrees: async () => {},
    listWorktrees: mainOnly,
    getWorktreeStatus: async () => ({ branch: 'dev', clean: true }),
    resolveIntegrationTip: async () => 'abc1234',
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

test('provision/match: installRunner is called for an already-attached worktree', async () => {
  const installed: string[] = [];
  const name = 'agent-existing';
  const existingEntry = fakeEntry(name);

  const svc = new WorktreeService(FAKE_WORKSPACE, FAKE_BASE, async () => 'dev', {
    pruneWorktrees: async () => {},
    // Match found in the initial list → short-circuit return, no provision.
    listWorktrees: async () => [
      { path: FAKE_WORKSPACE, branch: 'dev', head: 'abc' },
      existingEntry,
    ],
    resolveIntegrationTip: async () => 'abc1234',
    installRunner: async (cwd) => { installed.push(cwd); },
  });

  const entry = await svc.ensureWorktree(name);

  assert.equal(entry.path, existingEntry.path, 'returns the existing entry');
  assert.equal(installed.length, 1, 'installRunner must run before reusing an already-attached worktree');
  assert.equal(installed[0], existingEntry.path);
});

// ── lockfile detection (the AHEAD bug: non-pnpm / polyglot repos) ─────────────

function lockfileDir(name: string, files: string[]): string {
  const dir = join(tmpDir, 'detect', name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), '');
  return dir;
}

test('detect: pnpm-lock.yaml → pnpm frozen install', () => {
  const dir = lockfileDir('pnpm', ['pnpm-lock.yaml', 'package.json']);
  assert.equal(detectInstallCommand(dir), 'pnpm install --frozen-lockfile');
});

test('detect: yarn.lock → yarn frozen install', () => {
  const dir = lockfileDir('yarn', ['yarn.lock', 'package.json']);
  assert.equal(detectInstallCommand(dir), 'yarn install --frozen-lockfile');
});

test('detect: package-lock.json → npm ci', () => {
  const dir = lockfileDir('npm', ['package-lock.json', 'package.json']);
  assert.equal(detectInstallCommand(dir), 'npm ci');
});

test('detect: no lockfile → null (even with a root package.json)', () => {
  const dir = lockfileDir('none', ['package.json']);
  assert.equal(detectInstallCommand(dir), null);
});

test('detect: non-Node repo (no manifest at all) → null', () => {
  const dir = lockfileDir('polyglot', ['Gemfile']);
  assert.equal(detectInstallCommand(dir), null);
});

test('detect: nested package-lock app produces nested npm ci step when root has no lockfile', () => {
  const root = lockfileDir('nested-root', ['package.json']);
  const appDir = join(root, 'apps', 'cia-fe');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'package.json'), '{}');
  writeFileSync(join(appDir, 'package-lock.json'), '{}');

  assert.equal(detectInstallCommand(root), null);
  assert.deepEqual(detectInstallSteps(root), [{ cwd: appDir, command: 'npm ci' }]);
});

test('default runner: no lockfile → resolves without spawning anything', async () => {
  const dir = lockfileDir('skip', ['Gemfile']);
  await assert.doesNotReject(() => defaultInstallRunner(dir));
});
