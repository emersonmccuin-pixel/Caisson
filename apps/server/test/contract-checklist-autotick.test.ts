// Slice E — contract → checklist-item binding (auto-tick on PASS) tests (pc-pty-chat-425).
//
// Four invariants verified:
//  1. Bound-tick: contract PASS with a matching kind:'contract' item → item ticks true.
//  2. Unbound-no-op: contract PASS with no matching item (wrong contractId) → no tick, no error.
//  3. Last-box-auto-move integration: bound contract is the last open box → card auto-moves
//     to Done exactly once (exercises C+E together; no double-move history churn).
//  4. No-checklist regression: contract PASS where the linked WI has no checklist → no-op, no error.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Project, Stage, ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-checklist-autotick-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getWorkItem,
  setDoneChecklist,
} = await import('@pc/db');

const { ContractService } = await import('@pc/app-services');
const { runVerificationOnTerminal } = await import('../src/services/agent-verification.ts');

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'done', name: 'Done', order: 1, isDone: true },
];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function mkProject(): Project {
  seq += 1;
  return createProject({
    slug: `autotick-${seq}-${Date.now().toString(36)}`,
    name: `AutoTick ${seq}`,
    stages,
    folderPath: join(tmpDir, `p${seq}`),
  });
}

// -- Test 1: bound-tick -- matching contractId -> item flips to done ----------

test('contract PASS with bound kind:contract item -> item ticks true', async () => {
  const p = mkProject();
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'T1' });

  const svc = new ContractService();
  const contract = svc.create({
    projectId: p.id as ULID,
    workItemId: wi.id,
    podName: 'coder',
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });

  setDoneChecklist(wi.id, [
    { id: 'bound', label: 'Build passes', done: false, kind: 'contract' as const, contractId: contract.id },
    { id: 'other', label: 'Docs updated', done: false, kind: 'manual' as const },
  ]);

  await runVerificationOnTerminal({
    contractId: contract.id as ULID,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
    project: p,
  });

  const result = getWorkItem(wi.id)!;
  const bound = result.doneChecklist!.find((item) => item.id === 'bound')!;
  const other = result.doneChecklist!.find((item) => item.id === 'other')!;

  assert.equal(bound.done, true, 'bound item must be ticked');
  assert.equal(other.done, false, 'unbound manual item must stay untouched');
});

// -- Test 2: unbound-no-op -- wrong contractId -> no tick ---------------------

test('contract PASS with no matching checklist item -> no tick, no error', async () => {
  const p = mkProject();
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'T2' });

  const svc = new ContractService();
  const contract = svc.create({
    projectId: p.id as ULID,
    workItemId: wi.id,
    podName: 'coder',
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });

  setDoneChecklist(wi.id, [
    {
      id: 'unrelated',
      label: 'Some other work',
      done: false,
      kind: 'contract' as const,
      contractId: '01ZZZZZZZZZZZZZZZZZZZZZZZA',
    },
  ]);

  const outcome = await runVerificationOnTerminal({
    contractId: contract.id as ULID,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
    project: p,
  });

  assert.ok(outcome, 'verification must succeed');
  assert.equal(outcome!.verificationStatus, 'passed');

  const result = getWorkItem(wi.id)!;
  const item = result.doneChecklist!.find((i) => i.id === 'unrelated')!;
  assert.equal(item.done, false, 'unbound item must remain unticked');
});

// -- Test 3: last-box-auto-move integration -- one move, no double-churn ------

test('bound contract is the last open box -> card auto-moves to Done exactly once', async () => {
  const p = mkProject();
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'T3' });

  const svc = new ContractService();
  const contract = svc.create({
    projectId: p.id as ULID,
    workItemId: wi.id,
    podName: 'coder',
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });

  setDoneChecklist(wi.id, [
    { id: 'sole', label: 'All done', done: false, kind: 'contract' as const, contractId: contract.id },
  ]);

  await runVerificationOnTerminal({
    contractId: contract.id as ULID,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
    project: p,
  });

  const result = getWorkItem(wi.id)!;

  assert.equal(result.doneChecklist![0].done, true, 'last box must be ticked');
  assert.equal(result.stageId, 'done', 'card must be in the isDone stage');
  assert.equal(result.status, 'complete', 'status must be complete');

  const moveEntries = result.history.filter((h) => h.kind === 'move');
  assert.equal(moveEntries.length, 1, 'exactly one move history entry -- no double-churn');
});

// -- Test 4: no-checklist regression -- no checklist -> no-op, no error -------

test('contract PASS where linked WI has no checklist -> no-op, no error', async () => {
  const p = mkProject();
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'T4' });

  const svc = new ContractService();
  const contract = svc.create({
    projectId: p.id as ULID,
    workItemId: wi.id,
    podName: 'coder',
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

  assert.ok(outcome, 'verification must not throw');
  assert.equal(outcome!.verificationStatus, 'passed', 'contract must still pass');

  const result = getWorkItem(wi.id)!;
  assert.ok(
    result.doneChecklist == null || result.doneChecklist.length === 0,
    'checklist must remain absent',
  );
  assert.equal(result.stageId, 'done', 'WI still auto-advances via contract roll-up');
});
