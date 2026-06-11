// Worktree sweep runner — in-flight guard, per-project isolation, failure
// logging. Pure unit: fake runtimes, no git, no DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorktreeSweepRunner } from '../src/services/worktree-sweep-runner.ts';
import type { WorktreeService, WorktreeSweepResult } from '../src/services/worktree.ts';

const EMPTY: WorktreeSweepResult = {
  removedWorktrees: [],
  deletedBranches: [],
  removedHusks: [],
  kept: [],
  failed: [],
};

function fakeRuntime(sweep: (inUse: Iterable<string>) => Promise<WorktreeSweepResult>) {
  return {
    worktreeBaseDir: 'C:/fake/worktrees/p',
    worktrees: () => ({ sweepStale: sweep }) as unknown as WorktreeService,
  };
}

test('per-project isolation: one failing project does not stop the others', async () => {
  const swept: string[] = [];
  const warns: string[] = [];
  const runtimes: Record<string, ReturnType<typeof fakeRuntime>> = {
    a: fakeRuntime(async () => { swept.push('a'); return EMPTY; }),
    b: fakeRuntime(async () => {
      throw new Error('cannot detect an integration branch for project "b"');
    }),
    c: fakeRuntime(async () => { swept.push('c'); return EMPTY; }),
  };
  const runner = createWorktreeSweepRunner({
    listProjects: () => [
      { id: 'a', slug: 'proj-a' },
      { id: 'b', slug: 'proj-b' },
      { id: 'c', slug: 'proj-c' },
    ],
    getRuntime: (id) => runtimes[id] ?? null,
    collectInUse: () => [],
    dirExists: () => true,
    log: () => {},
    warn: (m) => warns.push(m),
  });

  await runner.runOnce();
  assert.deepEqual(swept, ['a', 'c'], 'projects after the failing one still sweep');
  assert.ok(
    warns.some((w) => w.includes('proj-b') && w.includes('integration branch')),
    'the failing project is loudly logged',
  );
});

test('in-flight guard: a second runOnce during a slow sweep is a no-op', async () => {
  let sweeps = 0;
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const runner = createWorktreeSweepRunner({
    listProjects: () => [{ id: 'a', slug: 'proj-a' }],
    getRuntime: () => fakeRuntime(async () => { sweeps += 1; await gate; return EMPTY; }),
    collectInUse: () => [],
    dirExists: () => true,
    log: () => {},
    warn: () => {},
  });

  const first = runner.runOnce();
  await runner.runOnce(); // resolves immediately — guard active
  assert.equal(sweeps, 1, 'no concurrent second sweep');
  release();
  await first;

  await runner.runOnce(); // guard released after completion
  assert.equal(sweeps, 2, 'subsequent runs proceed once the first finishes');
});

test('failures in the sweep result are logged at warn with op + message', async () => {
  const warns: string[] = [];
  const logs: string[] = [];
  const runner = createWorktreeSweepRunner({
    listProjects: () => [{ id: 'a', slug: 'proj-a' }],
    getRuntime: () =>
      fakeRuntime(async () => ({
        ...EMPTY,
        kept: [{ name: 'agent-w', reason: 'unmerged' }],
        failed: [{ name: 'agent-x', op: 'worktree-remove', message: 'EBUSY: locked' }],
      })),
    collectInUse: () => [],
    dirExists: () => true,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  });

  await runner.runOnce();
  assert.ok(
    warns.some((w) => w.includes('worktree-remove') && w.includes('agent-x') && w.includes('EBUSY')),
    `failure line carries op + name + real message; got: ${warns.join(' | ')}`,
  );
  assert.ok(
    logs.some((l) => l.includes('1 FAILED')),
    'summary line flags the failure count',
  );
});

test('in-use scan failure skips the whole pass loudly', async () => {
  let swept = 0;
  const warns: string[] = [];
  const runner = createWorktreeSweepRunner({
    listProjects: () => [{ id: 'a', slug: 'proj-a' }],
    getRuntime: () => fakeRuntime(async () => { swept += 1; return EMPTY; }),
    collectInUse: () => { throw new Error('db locked'); },
    dirExists: () => true,
    log: () => {},
    warn: (m) => warns.push(m),
  });

  await runner.runOnce();
  assert.equal(swept, 0, 'no sweeping without a trustworthy in-use list');
  assert.ok(warns.some((w) => w.includes('in-use scan failed')));
});

test('projects with no worktree dir on disk are skipped silently', async () => {
  let swept = 0;
  const runner = createWorktreeSweepRunner({
    listProjects: () => [{ id: 'a', slug: 'proj-a' }],
    getRuntime: () => fakeRuntime(async () => { swept += 1; return EMPTY; }),
    collectInUse: () => [],
    dirExists: () => false,
    log: () => {},
    warn: () => {},
  });

  await runner.runOnce();
  assert.equal(swept, 0);
});
