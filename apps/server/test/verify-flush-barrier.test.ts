// Slice 7 guardrail -- write-flush barrier + inconclusive outcome.
//
// Principle 2c (pc-pty-chat-374.5):
//
// 1. FLUSH BARRIER: side-effecting predicates (bash_exit_zero / files_exist)
//    on a worktree dispatch run only AFTER the agent's writes are committed.
//    A dirty/uncommitted worktree -> inconclusive (pending), NOT failed.
//    Guards against running bash build checks against a half-written tree.
//
// 2. INCONCLUSIVE OUTCOME: a bash_exit_zero predicate that fails with EMPTY
//    captured evidence (exit 127 / spawn error) is a VERIFICATION defect,
//    not a WORK defect. Surface as pending/inconclusive with a distinct note.
//    A real FAIL with evidence (tsc errors in the tail) stays failed.
//
// LOCKED DECISIONS (per work item):
//   #3: inconclusive is note-only; verificationStatus stays 'pending' with a
//       note containing the word "inconclusive".
//   #4: repo/worktree predicates need committed state; dirty tree = not-ready.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-verify-barrier-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  getContract,
} = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');

import type { Project, Stage, ULID } from '@pc/domain';
import type { PredicateExecutors } from '@pc/domain';
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

/** Minimal mock executor whose runBash always returns the given result. */
function mockExec(
  result: Awaited<ReturnType<PredicateExecutors['runBash']>>,
): PredicateExecutors {
  return {
    fileSize: async () => 1,
    runBash: async () => result,
  };
}

// ---- flush barrier: dirty worktree blocks side-effecting predicates ---------

test('flush barrier: dirty worktree + bash_exit_zero -> pending', async () => {
  const p = mkProject('barrier-dirty-bash');
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: null,
    podName: 'coder',
    expectedOutput: { kind: 'repo', isolation: 'worktree' },
    acceptanceCriteria: [{ kind: 'bash_exit_zero', command: 'pnpm typecheck' }],
    verificationTier: 'auto',
  });

  const outcome = await runVerificationOnTerminal(
    {
      contractId: contract.id as ULID,
      terminalStatus: 'completed',
      failureReason: null,
      projectFolderPath: tmpDir,
      worktreeDir: tmpDir,
    },
    {
      // Dirty worktree: agent left uncommitted changes
      checkDirtyWorktree: async () => true,
      // Executor would pass if reached -- but the barrier must fire first
      executorsFor: () => mockExec({ exitCode: 0, timedOut: false }),
    },
  );

  assert.ok(outcome, 'outcome must be non-null');
  assert.equal(outcome!.verificationStatus, 'pending',
    'dirty worktree must yield pending, not failed');
  assert.ok(
    outcome!.notes?.includes('inconclusive'),
    'notes must say inconclusive; got: ' + outcome!.notes,
  );
  assert.equal(outcome!.predicatesEvaluated, 0,
    'predicates must NOT run against a dirty worktree');

  const stored = getContract(contract.id as ULID);
  assert.equal(stored?.verificationStatus, 'pending', 'DB must reflect pending');
});

test('flush barrier: dirty worktree + files_exist -> pending', async () => {
  const p = mkProject('barrier-dirty-files');
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: null,
    podName: 'coder',
    expectedOutput: { kind: 'repo', isolation: 'worktree' },
    acceptanceCriteria: [{ kind: 'files_exist', paths: ['src/index.ts'] }],
    verificationTier: 'auto',
  });

  const outcome = await runVerificationOnTerminal(
    {
      contractId: contract.id as ULID,
      terminalStatus: 'completed',
      failureReason: null,
      projectFolderPath: tmpDir,
      worktreeDir: tmpDir,
    },
    {
      checkDirtyWorktree: async () => true,
      executorsFor: () => mockExec({ exitCode: 0, timedOut: false }),
    },
  );

  assert.ok(outcome);
  assert.equal(outcome!.verificationStatus, 'pending',
    'dirty worktree must yield pending for files_exist too');
  assert.ok(outcome!.notes?.includes('inconclusive'));
});

test('flush barrier: clean worktree lets verification proceed normally', async () => {
  const p = mkProject('barrier-clean');
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: null,
    podName: 'coder',
    expectedOutput: { kind: 'repo', isolation: 'worktree' },
    acceptanceCriteria: [{ kind: 'bash_exit_zero', command: 'pnpm typecheck' }],
    verificationTier: 'auto',
  });

  const outcome = await runVerificationOnTerminal(
    {
      contractId: contract.id as ULID,
      terminalStatus: 'completed',
      failureReason: null,
      projectFolderPath: tmpDir,
      worktreeDir: tmpDir,
    },
    {
      // Clean worktree: barrier does NOT fire
      checkDirtyWorktree: async () => false,
      executorsFor: () => mockExec({ exitCode: 0, timedOut: false }),
    },
  );

  assert.ok(outcome);
  assert.equal(outcome!.verificationStatus, 'passed',
    'clean worktree + passing bash must yield passed');
  assert.equal(outcome!.predicatesEvaluated, 1,
    'predicate must run when tree is clean');
});

test('flush barrier: legacy stored in_place spec is gated like any repo contract (pc-pty-chat-415 R3)', async () => {
  // in_place is deleted; the barrier keys off `kind: repo`, so even a
  // historical contract row that still spells `isolation: in_place` gets the
  // dirty-tree gate — there is no isolation value that exempts code work.
  const p = mkProject('barrier-inplace');
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: null,
    podName: 'coder',
    expectedOutput: { kind: 'repo', isolation: 'in_place' as unknown as 'worktree' },
    acceptanceCriteria: [{ kind: 'bash_exit_zero', command: 'echo ok' }],
    verificationTier: 'auto',
  });

  const outcome = await runVerificationOnTerminal(
    {
      contractId: contract.id as ULID,
      terminalStatus: 'completed',
      failureReason: null,
      projectFolderPath: tmpDir,
      worktreeDir: tmpDir,
    },
    {
      checkDirtyWorktree: async () => true,
      executorsFor: () => mockExec({ exitCode: 0, timedOut: false }),
    },
  );

  assert.ok(outcome);
  assert.equal(outcome!.verificationStatus, 'pending',
    'dirty tree must gate every repo contract, legacy in_place included');
});

// ---- inconclusive outcome: empty evidence = verification defect -------------

test('inconclusive: exit 127 + no output -> pending with inconclusive note', async () => {
  const p = mkProject('inconclusive-127');
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: null,
    podName: 'coder',
    expectedOutput: { kind: 'repo', isolation: 'worktree' },
    acceptanceCriteria: [{ kind: 'bash_exit_zero', command: 'pnpm typecheck' }],
    verificationTier: 'auto',
  });

  const outcome = await runVerificationOnTerminal(
    {
      contractId: contract.id as ULID,
      terminalStatus: 'completed',
      failureReason: null,
      projectFolderPath: tmpDir,
      worktreeDir: tmpDir,
    },
    {
      checkDirtyWorktree: async () => false,
      // Executor could not run the command: exit 127, no output
      executorsFor: () => mockExec({ exitCode: 127, timedOut: false }),
    },
  );

  assert.ok(outcome);
  assert.equal(outcome!.verificationStatus, 'pending',
    'exit 127 with no output must be pending, not failed');
  assert.ok(
    outcome!.notes?.includes('inconclusive'),
    'notes must say inconclusive; got: ' + outcome!.notes,
  );

  const stored = getContract(contract.id as ULID);
  assert.equal(stored?.verificationStatus, 'pending');
  assert.ok(
    stored?.verificationNotes?.includes('inconclusive'),
    'stored notes must say inconclusive; got: ' + stored?.verificationNotes,
  );
});

test('genuine failure: exit 1 WITH stderr output -> failed (not inconclusive)', async () => {
  const p = mkProject('genuine-fail');
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: null,
    podName: 'coder',
    expectedOutput: { kind: 'repo', isolation: 'worktree' },
    acceptanceCriteria: [{ kind: 'bash_exit_zero', command: 'pnpm typecheck' }],
    verificationTier: 'auto',
  });

  const outcome = await runVerificationOnTerminal(
    {
      contractId: contract.id as ULID,
      terminalStatus: 'completed',
      failureReason: null,
      projectFolderPath: tmpDir,
      worktreeDir: tmpDir,
    },
    {
      checkDirtyWorktree: async () => false,
      // Executor ran and found a real type error
      executorsFor: () =>
        mockExec({
          exitCode: 1,
          timedOut: false,
          stderrTail: 'src/foo.ts(3,5): error TS2322: Type string not assignable',
        }),
    },
  );

  assert.ok(outcome);
  assert.equal(outcome!.verificationStatus, 'failed',
    'real failure with evidence must flip to failed');
  assert.ok(
    !(outcome!.notes ?? '').includes('inconclusive'),
    'notes must NOT say inconclusive for genuine failure; got: ' + outcome!.notes,
  );
});

test('mixed inconclusive + genuine failure -> failed (genuine wins)', async () => {
  const p = mkProject('mixed-fail');
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: null,
    podName: 'coder',
    expectedOutput: { kind: 'repo', isolation: 'worktree' },
    acceptanceCriteria: [
      { kind: 'bash_exit_zero', command: 'pnpm typecheck' },
      { kind: 'bash_exit_zero', command: 'pnpm test' },
    ],
    verificationTier: 'auto',
  });

  let callCount = 0;
  const mixedExec: PredicateExecutors = {
    fileSize: async () => null,
    runBash: async () => {
      callCount++;
      // first call: inconclusive (exit 127, no output)
      if (callCount === 1) return { exitCode: 127, timedOut: false };
      // second call: genuine failure with output
      return { exitCode: 1, timedOut: false, stderrTail: 'test failed' };
    },
  };

  const outcome = await runVerificationOnTerminal(
    {
      contractId: contract.id as ULID,
      terminalStatus: 'completed',
      failureReason: null,
      projectFolderPath: tmpDir,
      worktreeDir: tmpDir,
    },
    {
      checkDirtyWorktree: async () => false,
      executorsFor: () => mixedExec,
    },
  );

  assert.ok(outcome);
  assert.equal(outcome!.verificationStatus, 'failed',
    'inconclusive + genuine failure must produce failed');
});

test('git_diff_nonempty is not in the flush-barrier predicate set', async () => {
  const p = mkProject('gitdiff-not-barrier');
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: null,
    podName: 'coder',
    expectedOutput: { kind: 'repo', isolation: 'worktree' },
    acceptanceCriteria: [{ kind: 'git_diff_nonempty', cwd: 'worktree' }],
    verificationTier: 'auto',
  });

  const outcome = await runVerificationOnTerminal(
    {
      contractId: contract.id as ULID,
      terminalStatus: 'completed',
      failureReason: null,
      projectFolderPath: tmpDir,
      worktreeDir: tmpDir,
    },
    {
      // Even with dirty worktree, git_diff_nonempty is NOT in the barrier set
      checkDirtyWorktree: async () => true,
      executorsFor: () => ({
        fileSize: async () => null,
        runBash: async () => ({ exitCode: 0, timedOut: false }),
        hasGitDiff: async () => true,
      }),
    },
  );

  assert.ok(outcome);
  assert.equal(outcome!.verificationStatus, 'passed',
    'git_diff_nonempty is not in the bash/files barrier set');
});
