// Phase 1.2 (pc-pty-chat-276.3) -- Characterization tests for the unified
// review-decision service.
//
// Four tests prove both approve AND reject route through applyReviewDecision
// for both kinds:
//   1. workflow-gate approve -> run advances (loop-back mechanic unchanged)
//   2. workflow-gate reject  -> run kicks back; second reject blocked
//   3. verification-hold approve -> contract accepted, WI complete
//   4. verification-hold reject  -> continuation dispatched (mechanic unchanged)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowV2 } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-rds-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getContract,
  insertAgentRunRow,
  newId,
  workflowRunsV2Repo,
} = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');
const { applyReviewDecision } = await import('../src/services/review-decision-service.ts');
const { WorkItemService } = await import('../src/services/work-item.ts');
const { WorktreeService } = await import('../src/services/worktree.ts');
const { initDagState, markRunning, markAwaitingReview } = await import('@pc/workflows');

import type { ULID } from '@pc/domain';
import type { DagRunServiceOptions } from '../src/services/dag-run-service.ts';
import type { DispatchAgentResult } from '../src/services/agent-run-factory.ts';

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

// A workflow: agent -> review (reject -> loop), terminal on approve.
function loopWorkflow(): WorkflowV2.Workflow {
  return {
    id: 'wf-rds-test',
    name: 'RDS Test',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'coder', task: 'build', next: ['r'] },
      { id: 'r', kind: 'review', reviewer: 'human', reject: 'lp' },
      { id: 'lp', kind: 'loop', back_to: 'a', max_iterations: 3 },
    ],
  };
}

function makeDagOpts(project: import('@pc/domain').Project): DagRunServiceOptions {
  return {
    projectId: project.id as ULID,
    workspaceDir: tmpDir,
    getProject: () => project,
    workItemService: new WorkItemService({
      projectId: project.id as ULID,
      getProject: () => project,
      getFieldSchemas: () => [],
    }),
    worktrees: new WorktreeService(tmpDir, tmpDir, async () => 'dev'),
    sessionDirFor: () => tmpDir,
    broadcast: () => {},
  };
}

// -- 1. workflow-gate approve -----------------------------------------------

test('workflow-gate approve routes through service and advances the run', async () => {
  const slug = 'rds-wfa-' + String(Date.now());
  const project = createProject({ slug, name: slug, stages, folderPath: join(tmpDir, slug) });
  const workflow = loopWorkflow();
  const dagOpts = makeDagOpts(project);

  let state = initDagState(workflow);
  state = markRunning(state, 'r');
  state = markAwaitingReview(state, 'r', 'i0');

  const run = workflowRunsV2Repo.createRun({
    workflowId: workflow.id,
    workflowName: workflow.name,
    projectId: project.id as ULID,
    workflowYamlSnapshot: JSON.stringify(workflow),
    status: 'paused',
    dagState: state,
  });

  const result = await applyReviewDecision(
    { kind: 'workflow-gate', runId: run.id as ULID, nodeId: 'r', decision: { kind: 'approve' } },
    { kind: 'workflow-gate', dagOpts },
  );

  if (!result.ok) { throw new Error('service must succeed: ' + JSON.stringify(result)); }
  if (result.kind !== 'workflow-gate') { throw new Error('expected workflow-gate kind'); }
  const valid = ['running', 'awaiting-review', 'completed'];
  assert.ok(valid.includes(result.status), 'unexpected status: ' + result.status);
});

// -- 2. workflow-gate reject -> kick-back; second reject blocked -------------

test('workflow-gate reject kicks back and second reject is blocked', async () => {
  const slug = 'rds-wfr-' + String(Date.now());
  const project = createProject({ slug, name: slug, stages, folderPath: join(tmpDir, slug) });
  const workflow = loopWorkflow();
  const dagOpts = makeDagOpts(project);

  let state = initDagState(workflow);
  state = markRunning(state, 'r');
  state = markAwaitingReview(state, 'r', 'i0');

  const run = workflowRunsV2Repo.createRun({
    workflowId: workflow.id,
    workflowName: workflow.name,
    projectId: project.id as ULID,
    workflowYamlSnapshot: JSON.stringify(workflow),
    status: 'paused',
    dagState: state,
  });

  const first = await applyReviewDecision(
    {
      kind: 'workflow-gate',
      runId: run.id as ULID,
      nodeId: 'r',
      decision: { kind: 'reject', notes: 'redo it' },
    },
    { kind: 'workflow-gate', dagOpts },
  );

  if (!first.ok) { throw new Error('first reject must succeed: ' + JSON.stringify(first)); }
  if (first.kind !== 'workflow-gate') { throw new Error('expected workflow-gate kind'); }

  // Second reject on the now-reset gate must be blocked with not-awaiting.
  const second = await applyReviewDecision(
    { kind: 'workflow-gate', runId: run.id as ULID, nodeId: 'r', decision: { kind: 'reject', notes: 'again' } },
    { kind: 'workflow-gate', dagOpts },
  );
  assert.ok(!second.ok, 'second reject on reset gate must fail');
  if (second.ok) { throw new Error('impossible'); }
  assert.equal(second.code, 'not-awaiting', 'error code must be not-awaiting');
});

// -- 3. verification-hold approve -------------------------------------------

test('verification-hold approve routes through service -> contract accepted + WI complete', async () => {
  const slug = 'rds-vha-' + String(Date.now());
  const project = createProject({ slug, name: slug, stages, folderPath: join(tmpDir, slug) });

  const wi = createWorkItem({ projectId: project.id as ULID, stageId: 'todo', title: 'test-wi-approve' });
  const svc = new ContractService();
  const contract = svc.create({
    projectId: project.id as ULID,
    workItemId: wi.id as ULID,
    podName: 'builder',
    acceptanceCriteria: [],
    verificationTier: 'human-review',
  });
  svc.setVerification({ id: contract.id as ULID, verificationStatus: 'pending' });

  const result = await applyReviewDecision(
    {
      kind: 'verification-hold',
      workItemId: wi.id as ULID,
      decision: { kind: 'approve', actor: 'orchestrator', notes: 'lgtm' },
      project,
    },
    { kind: 'verification-hold' },
  );

  if (!result.ok) { throw new Error('service must succeed: ' + JSON.stringify(result)); }
  if (result.kind !== 'verification-hold') { throw new Error('expected verification-hold kind'); }
  assert.ok(result.workItem, 'workItem must be returned');
  assert.equal(result.workItem!.status, 'complete', 'WI must be complete after approve');

  const updated = getContract(contract.id as ULID);
  assert.ok(updated, 'contract must exist');
  assert.equal(updated!.status, 'accepted', 'contract must be accepted');
});

// -- 4. verification-hold reject --------------------------------------------

test('verification-hold reject routes through service -> continuation dispatched', async () => {
  const slug = 'rds-vhr-' + String(Date.now());
  const project = createProject({ slug, name: slug, stages, folderPath: join(tmpDir, slug) });

  const wi = createWorkItem({ projectId: project.id as ULID, stageId: 'todo', title: 'test-wi-reject' });
  const svc = new ContractService();
  const contract = svc.create({
    projectId: project.id as ULID,
    workItemId: wi.id as ULID,
    podName: 'builder',
    acceptanceCriteria: [],
    verificationTier: 'human-review',
  });

  const runId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'builder',
    dispatcherSessionId: 'disp-rds-vhr',
    ccSessionId: 'cc-rds-vhr',
    status: 'running',
    input: 'go',
    queuedAt: Date.now(),
  });
  svc.setRun(contract.id as ULID, runId as ULID);
  svc.setVerification({ id: contract.id as ULID, verificationStatus: 'pending' });

  const dispatchCalls: unknown[] = [];
  const stubDispatch = async (...args: unknown[]): Promise<DispatchAgentResult> => {
    dispatchCalls.push(args);
    return { ok: false as const, cause: 'host-unavailable' as const, error: 'stubbed' };
  };

  const result = await applyReviewDecision(
    {
      kind: 'verification-hold',
      workItemId: wi.id as ULID,
      decision: {
        kind: 'reject',
        feedback: 'the output is wrong',
        actor: 'orchestrator',
        dispatcherSessionId: 'disp-rds-vhr',
      },
      project,
    },
    {
      kind: 'verification-hold',
      dispatch: stubDispatch as typeof import('../src/services/agent-run-factory.ts').dispatchContinueAgent,
    },
  );

  if (!result.ok) { throw new Error('service must succeed: ' + JSON.stringify(result)); }
  if (result.kind !== 'verification-hold') { throw new Error('expected verification-hold kind'); }
  assert.equal(dispatchCalls.length, 1, 'dispatchContinueAgent must be called exactly once');

  const updated = getContract(contract.id as ULID);
  assert.ok(updated, 'contract must exist');
  assert.equal(updated!.status, 'rejected', 'contract must be rejected');
  assert.ok(
    updated!.verificationNotes && updated!.verificationNotes.includes('the output is wrong'),
    'feedback must be in verificationNotes',
  );
});
