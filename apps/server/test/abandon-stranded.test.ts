// pc-pty-chat-415 (R12/R14) — abandon flow + stranded surfacing.
//
// abandonContractWorkspace: record FIRST (branch + tip on the contract), then
// reclaim the worktree DIR; the branch survives. Refuses on live runs,
// landed work, and workflow-owned runs. Idempotent re-abandon retries the
// teardown without overwriting the preservation record.
//
// WorktreeService.listStranded: read-only report of unmerged work no live run
// references — both registered worktrees and worktree-less branches.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-abandon-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createProject, getContract, insertAgentRunRow, newId } =
  await import('@pc/db');
const { ContractService } = await import('@pc/app-services');
const { abandonContractWorkspace } = await import('../src/services/landing-service.ts');
const { WorktreeService } = await import('../src/services/worktree.ts');

import type { Stage, ULID } from '@pc/domain';
import type { LandingWorktrees } from '../src/services/landing-service.ts';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function fakeWorktrees(opts?: { abandonThrows?: string }): { wt: LandingWorktrees; calls: string[] } {
  const calls: string[] = [];
  const wt: LandingWorktrees = {
    integrationBranch: async () => 'dev',
    mergeState: async () => ({ mergeInProgress: false, alreadyMerged: false, pushed: false }),
    mergeBranchIntoIntegration: async () => {
      calls.push('merge');
    },
    pushIntegration: async () => {
      calls.push('push');
    },
    teardownAfterMerge: async () => {
      calls.push('teardown');
    },
    teardownAfterAbandon: async (branch: string) => {
      calls.push(`abandon:${branch}`);
      if (opts?.abandonThrows) throw new Error(opts.abandonThrows);
    },
  };
  return { wt, calls };
}

function seedRepoContract(slug: string, worktreeDir: string, runStatus = 'failed') {
  const p = createProject({ slug, name: slug, stages, folderPath: join(tmpDir, slug) });
  const service = new ContractService();
  const contract = service.create({
    projectId: p.id as ULID,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo' },
  });
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: p.id as ULID,
    podName: 'code-writer',
    dispatcherSessionId: 's',
    ccSessionId: 'cc',
    status: runStatus as 'failed',
    input: 'go',
    contractId: contract.id as ULID,
    worktreeDir,
    queuedAt: Date.now(),
  });
  service.setRun(contract.id as ULID, runId);
  return { p, service, contract, runId };
}

// ── abandonContractWorkspace ─────────────────────────────────────────────────

test('abandon: records branch + tip FIRST, then reclaims the dir (branch preserved)', async () => {
  const WT = join(tmpDir, 'worktrees', 'ab-ok', 'agent-deadbeef');
  const { contract } = seedRepoContract('ab-ok', WT);
  const { wt, calls } = fakeWorktrees();

  const result = await abandonContractWorkspace(contract.id as ULID, {
    worktreesFor: () => wt,
    headSha: async () => 'tip123',
    now: () => 777,
  });

  assert.deepEqual(result, {
    ok: true,
    branch: 'agent-deadbeef',
    preservedSha: 'tip123',
    teardown: 'removed',
  });
  assert.deepEqual(calls, ['abandon:agent-deadbeef'], 'dir reclaim only — never merge/push');
  const row = getContract(contract.id as ULID)!;
  assert.equal(row.landingStatus, 'abandoned');
  assert.equal(row.landedBranch, 'agent-deadbeef');
  assert.equal(row.landedSha, 'tip123', 'the preserved tip is the durable record');
  assert.equal(row.landedAt, 777);
});

test('abandon: refuses while the producing run is still active', async () => {
  const WT = join(tmpDir, 'worktrees', 'ab-live', 'agent-cafe0001');
  const { contract } = seedRepoContract('ab-live', WT, 'running');
  const result = await abandonContractWorkspace(contract.id as ULID, {
    worktreesFor: () => fakeWorktrees().wt,
    headSha: async () => 'x',
  });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /still running/);
  assert.equal(getContract(contract.id as ULID)!.landingStatus, null, 'nothing recorded');
});

test('abandon: refuses landed work', async () => {
  const WT = join(tmpDir, 'worktrees', 'ab-landed', 'agent-cafe0002');
  const { service, contract } = seedRepoContract('ab-landed', WT);
  service.setLanding({ id: contract.id as ULID, landingStatus: 'landed', landedBranch: 'agent-cafe0002' });
  const result = await abandonContractWorkspace(contract.id as ULID, {
    worktreesFor: () => fakeWorktrees().wt,
    headSha: async () => 'x',
  });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /already landed/);
});

test('abandon: workflow-owned runs are refused — cancel/resume the workflow instead', async () => {
  const WT = join(tmpDir, 'worktrees', 'ab-wf', 'wf-12345678');
  const { contract } = seedRepoContract('ab-wf', WT);
  const result = await abandonContractWorkspace(contract.id as ULID, {
    worktreesFor: () => fakeWorktrees().wt,
    headSha: async () => 'x',
  });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /workflow-owned/);
});

test('abandon: re-abandon retries teardown WITHOUT overwriting the preserved sha', async () => {
  const WT = join(tmpDir, 'worktrees', 'ab-retry', 'agent-cafe0003');
  const { contract } = seedRepoContract('ab-retry', WT);

  // First attempt: teardown fails (Windows lock); record stands.
  const first = await abandonContractWorkspace(contract.id as ULID, {
    worktreesFor: () => fakeWorktrees({ abandonThrows: 'EBUSY: locked' }).wt,
    headSha: async () => 'original-tip',
  });
  assert.equal(first.ok && first.teardown, 'failed');
  assert.equal(getContract(contract.id as ULID)!.landedSha, 'original-tip');

  // Retry: dir is gone now (headSha would read null) — the record must keep
  // the ORIGINAL tip; teardown succeeds this time.
  const second = await abandonContractWorkspace(contract.id as ULID, {
    worktreesFor: () => fakeWorktrees().wt,
    headSha: async () => null,
  });
  assert.equal(second.ok && second.teardown, 'removed');
  assert.equal(
    getContract(contract.id as ULID)!.landedSha,
    'original-tip',
    're-abandon must not overwrite the preservation record',
  );
});

// ── WorktreeService.listStranded ─────────────────────────────────────────────

test('listStranded: unmerged + not-in-use surfaces; merged and in-use do not', async () => {
  const base = join(tmpDir, 'wt-base');
  const mergedBranches = new Set(['agent-merged1']);
  const svc = new WorktreeService(join(tmpDir, 'workspace'), base, async () => 'dev', {
    listWorktrees: async () => [
      { path: join(tmpDir, 'workspace'), branch: 'dev' }, // main repo entry
      { path: join(base, 'agent-stranded1'), branch: 'agent-stranded1' },
      { path: join(base, 'agent-merged1'), branch: 'agent-merged1' },
      { path: join(base, 'agent-inuse1'), branch: 'agent-inuse1' },
    ] as never,
    branchMergedInto: async (_ws, branch) => mergedBranches.has(branch),
    listBranchesByPrefix: async () => ['agent-stranded1', 'agent-merged1', 'agent-orphan1'],
    pruneWorktrees: async () => {},
  });

  const stranded = await svc.listStranded([join(base, 'agent-inuse1')]);
  const names = stranded.map((s) => s.name).sort();
  assert.deepEqual(names, ['agent-orphan1', 'agent-stranded1']);
  const orphan = stranded.find((s) => s.name === 'agent-orphan1')!;
  assert.equal(orphan.path, null, 'worktree-less branch reports a null path');
});
