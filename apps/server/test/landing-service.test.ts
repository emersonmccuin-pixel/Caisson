// pc-pty-chat-415 (R5) — accept ⇒ land.
//
// landBranch — the ONE landing mechanics (shared by the workflow merge node
// and acceptance-side landing): idempotent state read → merge → receipt #1 →
// push → receipt #2 → best-effort teardown. Typed outcomes, never throws.
//
// landAcceptedContract — acceptance-side door: standalone accepted repo
// contracts land on the integration branch; the outcome + receipts are
// durable on the contract; workflow-owned runs are skipped (the merge node
// owns them); conflicts park durably and notify.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-landing-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createProject, getContract, insertAgentRunRow, newId } =
  await import('@pc/db');
const { ContractService } = await import('@pc/app-services');
const { landBranch, landAcceptedContract } = await import('../src/services/landing-service.ts');

import type { Stage, ULID } from '@pc/domain';
import type { LandingWorktrees } from '../src/services/landing-service.ts';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Stateful fake: starts unmerged/unpushed; merge() flips merged; push() flips
 *  pushed. Records calls. */
function fakeWorktrees(opts?: {
  startMerged?: boolean;
  startPushed?: boolean;
  mergeInProgress?: boolean;
  mergeThrows?: string;
  pushThrows?: string;
}): { wt: LandingWorktrees; calls: string[] } {
  let merged = opts?.startMerged ?? false;
  let pushed = opts?.startPushed ?? false;
  const calls: string[] = [];
  const wt: LandingWorktrees = {
    integrationBranch: async () => 'dev',
    mergeState: async () => ({
      mergeInProgress: opts?.mergeInProgress ?? false,
      alreadyMerged: merged,
      pushed,
    }),
    mergeBranchIntoIntegration: async () => {
      calls.push('merge');
      if (opts?.mergeThrows) throw new Error(opts.mergeThrows);
      merged = true;
    },
    pushIntegration: async () => {
      calls.push('push');
      if (opts?.pushThrows) throw new Error(opts.pushThrows);
      pushed = true;
    },
    teardownAfterMerge: async () => {
      calls.push('teardown');
    },
    teardownAfterAbandon: async () => {
      calls.push('teardown-abandon');
    },
  };
  return { wt, calls };
}

// ── landBranch mechanics ─────────────────────────────────────────────────────

test('landBranch: fresh merge → merge, push, receipts, teardown', async () => {
  const { wt, calls } = fakeWorktrees();
  const result = await landBranch(wt, 'agent-abc');
  assert.deepEqual(result, { outcome: 'merged', into: 'dev', idempotent: false });
  assert.deepEqual(calls, ['merge', 'push', 'teardown']);
});

test('landBranch: already merged + pushed → idempotent, teardown only', async () => {
  const { wt, calls } = fakeWorktrees({ startMerged: true, startPushed: true });
  const result = await landBranch(wt, 'agent-abc');
  assert.deepEqual(result, { outcome: 'merged', into: 'dev', idempotent: true });
  assert.deepEqual(calls, ['teardown'], 'no merge, no push');
});

test('landBranch: merge in progress (MERGE_HEAD) → conflict, nothing touched', async () => {
  const { wt, calls } = fakeWorktrees({ mergeInProgress: true });
  const result = await landBranch(wt, 'agent-abc');
  assert.equal(result.outcome, 'conflict');
  assert.deepEqual(calls, [], 'no merge/push/teardown on a parked conflict');
});

test('landBranch: merge throws CONFLICT → conflict', async () => {
  const { wt } = fakeWorktrees({ mergeThrows: 'Automatic merge failed; CONFLICT (content)' });
  const result = await landBranch(wt, 'agent-abc');
  assert.equal(result.outcome, 'conflict');
});

test('landBranch: push rejected non-fast-forward → conflict', async () => {
  const { wt } = fakeWorktrees({ pushThrows: '! [rejected] dev -> dev (non-fast-forward)' });
  const result = await landBranch(wt, 'agent-abc');
  assert.equal(result.outcome, 'conflict');
});

test('landBranch: integration resolver failure → failed with the fix-it message', async () => {
  const { wt } = fakeWorktrees();
  wt.integrationBranch = async () => {
    throw new Error('configured integrationBranch "release/x" not found');
  };
  const result = await landBranch(wt, 'agent-abc');
  assert.equal(result.outcome, 'failed');
  assert.match((result as { error: string }).error, /not found/);
});

// ── record-then-teardown ordering (2026-07-03 durability fix) ────────────────

test('landBranch: onLanded fires after push receipts and BEFORE teardown', async () => {
  const { wt, calls } = fakeWorktrees();
  const result = await landBranch(wt, 'agent-abc', {
    onLanded: ({ into, idempotent }) => {
      calls.push(`record(${into},${idempotent})`);
    },
  });
  assert.equal(result.outcome, 'merged');
  assert.deepEqual(calls, ['merge', 'push', 'record(dev,false)', 'teardown']);
});

test('landBranch: onLanded fires on the idempotent path too, before teardown', async () => {
  const { wt, calls } = fakeWorktrees({ startMerged: true, startPushed: true });
  const result = await landBranch(wt, 'agent-abc', {
    onLanded: ({ idempotent }) => {
      calls.push(`record(idempotent=${idempotent})`);
    },
  });
  assert.deepEqual(result, { outcome: 'merged', into: 'dev', idempotent: true });
  assert.deepEqual(calls, ['record(idempotent=true)', 'teardown']);
});

test('landBranch: onLanded throw → typed failed, teardown NOT run (branch preserved for re-land)', async () => {
  const { wt, calls } = fakeWorktrees();
  const result = await landBranch(wt, 'agent-abc', {
    onLanded: () => {
      throw new Error('db write failed (simulated)');
    },
  });
  assert.equal(result.outcome, 'failed');
  assert.match((result as { error: string }).error, /landed-record write failed/);
  assert.deepEqual(calls, ['merge', 'push'], 'no teardown after a failed durable record');
});

// ── landAcceptedContract ─────────────────────────────────────────────────────

function seedAcceptedRepoContract(slug: string, worktreeDir: string | null) {
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
    status: 'completed',
    input: 'go',
    contractId: contract.id as ULID,
    worktreeDir: worktreeDir ?? undefined,
    queuedAt: Date.now(),
  });
  service.setRun(contract.id as ULID, runId);
  service.setDeliverable({
    id: contract.id as ULID,
    deliverable: { kind: 'repo', branch: 'agent-claimed', commit: 'sealed123' },
  });
  service.setVerification({ id: contract.id as ULID, verificationStatus: 'passed' });
  return { p, service, contract, runId };
}

test('landAcceptedContract: accepted standalone repo contract lands with durable receipts', async () => {
  const WT = join(tmpDir, 'worktrees', 'land-ok', 'agent-deadbeef');
  const { contract } = seedAcceptedRepoContract('land-ok', WT);
  const { wt, calls } = fakeWorktrees();

  const result = await landAcceptedContract(contract.id as ULID, {
    worktreesFor: () => wt,
    now: () => 1234567,
  });

  assert.deepEqual(result, {
    applicable: true,
    outcome: 'landed',
    branch: 'agent-deadbeef',
    into: 'dev',
  });
  assert.deepEqual(calls, ['merge', 'push', 'teardown']);
  const row = getContract(contract.id as ULID)!;
  assert.equal(row.landingStatus, 'landed');
  assert.equal(row.landedBranch, 'agent-deadbeef');
  assert.equal(row.landedSha, 'sealed123', 'receipt = the SEALED sha, not an agent claim');
  assert.equal(row.landedAt, 1234567);
});

test('landAcceptedContract: landed status is durable BEFORE the branch teardown (crash-window ordering)', async () => {
  const WT = join(tmpDir, 'worktrees', 'land-order', 'agent-0rder123');
  const { contract } = seedAcceptedRepoContract('land-order', WT);
  const { wt } = fakeWorktrees();
  const statusAtTeardown: (string | null)[] = [];
  const origTeardown = wt.teardownAfterMerge;
  wt.teardownAfterMerge = async (branch) => {
    statusAtTeardown.push(getContract(contract.id as ULID)!.landingStatus);
    await origTeardown(branch);
  };

  const result = await landAcceptedContract(contract.id as ULID, { worktreesFor: () => wt });

  assert.equal(result.applicable && result.outcome, 'landed');
  assert.deepEqual(
    statusAtTeardown,
    ['landed'],
    'the contract must already read landed when the branch teardown runs — a crash mid-teardown re-drives to the idempotent short-circuit',
  );
});

test('landAcceptedContract: conflict parks durably + notifies the dispatcher', async () => {
  const WT = join(tmpDir, 'worktrees', 'land-conflict', 'agent-cafef00d');
  const { contract, runId } = seedAcceptedRepoContract('land-conflict', WT);
  const { wt } = fakeWorktrees({ mergeThrows: 'CONFLICT (content): merge conflict in a.ts' });
  const notified: unknown[] = [];

  const result = await landAcceptedContract(contract.id as ULID, {
    worktreesFor: () => wt,
    notify: (msg) => notified.push(msg),
  });

  assert.equal(result.applicable && result.outcome, 'conflict');
  const row = getContract(contract.id as ULID)!;
  assert.equal(row.landingStatus, 'conflict');
  assert.match(row.landingError ?? '', /conflict/i);
  assert.equal(notified.length, 1);
  assert.equal((notified[0] as { runId: string }).runId, runId);
});

test('landAcceptedContract: workflow-owned run is skipped — the merge node lands it', async () => {
  const WT = join(tmpDir, 'worktrees', 'land-wf', 'wf-12345678');
  const { contract } = seedAcceptedRepoContract('land-wf', WT);
  const { wt, calls } = fakeWorktrees();

  const result = await landAcceptedContract(contract.id as ULID, { worktreesFor: () => wt });

  assert.equal(result.applicable, false);
  assert.deepEqual(calls, [], 'no git activity for a workflow-owned run');
  const row = getContract(contract.id as ULID)!;
  assert.equal(row.landingStatus, null, 'landing state stays null — not this door\'s job');
});

test('landAcceptedContract: legacy in-place run (cwd == project folder) is exempt', async () => {
  const slug = 'land-inplace';
  const { contract } = seedAcceptedRepoContract(slug, join(tmpDir, slug));
  const { wt, calls } = fakeWorktrees();

  const result = await landAcceptedContract(contract.id as ULID, { worktreesFor: () => wt });

  assert.equal(result.applicable, false);
  assert.deepEqual(calls, []);
});

test('landAcceptedContract: non-repo contract is not applicable', async () => {
  const p = createProject({ slug: 'land-answer', name: 'x', stages, folderPath: join(tmpDir, 'land-answer') });
  const service = new ContractService();
  const contract = service.create({
    projectId: p.id as ULID,
    podName: 'researcher',
    expectedOutput: { kind: 'answer' },
  });
  service.setVerification({ id: contract.id as ULID, verificationStatus: 'passed' });

  const result = await landAcceptedContract(contract.id as ULID, {
    worktreesFor: () => fakeWorktrees().wt,
  });
  assert.equal(result.applicable, false);
});

test('landAcceptedContract: re-drive of an already-landed contract short-circuits', async () => {
  const WT = join(tmpDir, 'worktrees', 'land-idem', 'agent-feedf00d');
  const { contract } = seedAcceptedRepoContract('land-idem', WT);
  const first = fakeWorktrees();
  await landAcceptedContract(contract.id as ULID, { worktreesFor: () => first.wt });

  const second = fakeWorktrees();
  const result = await landAcceptedContract(contract.id as ULID, {
    worktreesFor: () => second.wt,
  });
  assert.equal(result.applicable && result.outcome, 'landed');
  assert.deepEqual(second.calls, [], 'no second merge/push for an already-landed contract');
});

test('landAcceptedContract: unaccepted contract refuses to land', async () => {
  const WT = join(tmpDir, 'worktrees', 'land-unaccepted', 'agent-0badc0de');
  const p = createProject({ slug: 'land-unaccepted', name: 'x', stages, folderPath: join(tmpDir, 'land-unaccepted') });
  const service = new ContractService();
  const contract = service.create({
    projectId: p.id as ULID,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo' },
    worktreePath: WT,
  });

  const result = await landAcceptedContract(contract.id as ULID, {
    worktreesFor: () => fakeWorktrees().wt,
  });
  assert.equal(result.applicable, false, 'only ACCEPTED work lands');
});
