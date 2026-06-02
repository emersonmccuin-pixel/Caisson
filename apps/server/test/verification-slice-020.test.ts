// Slice 020 — verification & terminal go contract-authoritative.
//
// Proves the roll-up trigger: WI advance fires EXACTLY ONCE, on contract-accept,
// and ONLY for output-linked contracts.
//   - a contract with no WI verifies with no WI side effects.
//   - an output-linked contract acceptance advances its WI to the done stage
//     exactly once.
//   - a contract-only reject flips the contract without any WI write.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-verify-020-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getWorkItem,
  getContract,
} = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');

import type { Project, Stage, ULID } from '@pc/domain';
import { runVerificationOnTerminal } from '../src/services/agent-verification.ts';

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'done', name: 'Done', order: 1, isDone: true },
];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkProject(slug: string): Project {
  return createProject({ slug, name: slug, stages, folderPath: tmpDir });
}

// ── contract with no WI: verifies, zero WI side effects ───────────────────────

test('contract with no WI verifies (accepted) with no WI side effects', async () => {
  const p = mkProject('no-wi');
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: null,
    podName: 'researcher',
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });

  const outcome = await runVerificationOnTerminal({
    contractId: contract.id as ULID,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
    project: p,
  });

  assert.ok(outcome);
  assert.equal(outcome!.verificationStatus, 'passed');
  assert.equal(outcome!.workItemId, null);
  assert.equal(getContract(contract.id as ULID)!.status, 'accepted');
});

// ── output-linked contract accept advances the WI to done exactly once ────────

test('output-linked contract acceptance advances its WI to the done stage', async () => {
  const p = mkProject('linked');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'linked work',
  });
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: wi.id,
    podName: 'researcher',
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });

  const outcome = await runVerificationOnTerminal({
    contractId: contract.id as ULID,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
    project: p,
  });

  assert.ok(outcome);
  assert.equal(outcome!.verificationStatus, 'passed');
  assert.equal(outcome!.workItemId, wi.id);
  assert.equal(getContract(contract.id as ULID)!.status, 'accepted');
  const after = getWorkItem(wi.id)!;
  assert.equal(after.status, 'complete');
  assert.equal(after.stageId, 'done', 'WI auto-advanced to the done stage');
});

// ── the roll-up fires EXACTLY ONCE (no double-advance history) ────────────────

test('the WI roll-up fires exactly once on accept', async () => {
  const p = mkProject('once');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'once work',
  });
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: wi.id,
    podName: 'researcher',
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });

  await runVerificationOnTerminal({
    contractId: contract.id as ULID,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
    project: p,
  });

  const after = getWorkItem(wi.id)!;
  // One verification-pass history note + one stage move = the WI flipped once.
  const passes = after.history.filter((h) => h.note?.includes('verification passed')).length;
  assert.equal(passes, 1, 'verification-pass note recorded once');
  assert.equal(after.status, 'complete');
});

// ── contract-only reject flips the contract; no WI write ──────────────────────

test('failed terminal rejects the contract with no WI', async () => {
  const p = mkProject('reject-no-wi');
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: null,
    podName: 'researcher',
    verificationTier: 'auto',
  });

  const outcome = await runVerificationOnTerminal({
    contractId: contract.id as ULID,
    terminalStatus: 'failed',
    failureReason: 'agent died',
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
    project: p,
  });

  assert.ok(outcome);
  assert.equal(outcome!.verificationStatus, 'failed');
  assert.equal(outcome!.workItemId, null);
  assert.equal(getContract(contract.id as ULID)!.status, 'rejected');
});
