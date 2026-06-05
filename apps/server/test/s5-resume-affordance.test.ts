// S5 (FD-14) — the resume-interrupted-job affordance, server half.
//
// Pins two behaviors:
//  1. The failed-run notice is INCIDENT-keyed: `notifyRunFailed` carries the
//     count of `run_resumed` diary lines at failure time. The constant per-run
//     idempotency key silently dropped the SECOND failure of a resumed run
//     (FD-8 — no message silently dies); the incident number keys a fresh card
//     per failure while a crash-replay of the same incident still dedupes.
//  2. `resumeFailedDagRun` actions the run's open `workflow-run-failed` inbox
//     cards (resolve-by-source on sourceKind 'workflow-run' + runId) — resumed
//     through ANY door (inbox button, pc_resume_workflow_run, raw HTTP), the
//     cards never linger.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Project, ULID, WorkflowV2 } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-s5-resume-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createProject, runMigrations, workflowRunsV2Repo } = await import('@pc/db');
const { WorkflowRunMutationGateway } = await import('@pc/app-services');
const { makeExecutorDeps, resumeFailedDagRun } = await import('../src/services/dag-run-service.ts');
type DagRunServiceOptions = import('../src/services/dag-run-service.ts').DagRunServiceOptions;

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const WF: WorkflowV2.Workflow = {
  id: 'wf',
  name: 'S5 Flow',
  nodes: [{ id: 'a', kind: 'agent', agent: 'no-such-pod', task: 'go' }],
};

function seedProject(): ULID {
  return createProject({
    slug: `s5-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: 'S5',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: join(tmpDir, `s5-${Math.random().toString(36).slice(2, 7)}`),
  }).id as ULID;
}

/** Minimal opts — the pieces these paths actually touch are real (repos,
 *  gateway); the dispatch-side services are never reached (the test pod
 *  resolves to nothing → typed node failure). */
function makeOpts(
  projectId: ULID,
  over: Partial<DagRunServiceOptions> = {},
): DagRunServiceOptions {
  return {
    projectId,
    workspaceDir: tmpDir,
    getProject: () => ({ id: projectId } as unknown as Project),
    workItemService: {} as DagRunServiceOptions['workItemService'],
    worktrees: {} as DagRunServiceOptions['worktrees'],
    sessionDirFor: () => tmpDir,
    broadcast: () => {},
    ...over,
  };
}

test('notifyRunFailed carries the failure INCIDENT (run_resumed count at failure time)', () => {
  const projectId = seedProject();
  const run = workflowRunsV2Repo.createRun({
    workflowId: 'wf',
    workflowName: 'S5 Flow',
    projectId,
    workflowYamlSnapshot: JSON.stringify(WF),
    status: 'running',
  });

  const incidents: number[] = [];
  const deps = makeExecutorDeps(
    { id: run.id as ULID, workItemId: null, worktreePath: null },
    WF,
    makeOpts(projectId, { deliverRunFailed: (input) => incidents.push(input.incident) }),
  );

  deps.notifyRunFailed?.('boom');
  assert.deepEqual(incidents, [0], 'first failure = incident 0');

  // A resume writes its diary line — the next failure is a NEW incident.
  const gateway = new WorkflowRunMutationGateway();
  gateway.appendRunEvent({
    projectId,
    runId: run.id as ULID,
    type: 'run_resumed',
    data: { resetNodes: ['a'], defChanged: false },
  });
  deps.notifyRunFailed?.('boom again');
  assert.deepEqual(incidents, [0, 1], 'post-resume failure = incident 1 (fresh card key)');
});

test('resumeFailedDagRun actions the open workflow-run-failed cards (resolve-by-source)', async () => {
  const projectId = seedProject();
  const run = workflowRunsV2Repo.createRun({
    workflowId: 'wf',
    workflowName: 'S5 Flow',
    projectId,
    workflowYamlSnapshot: JSON.stringify(WF),
    status: 'running',
    dagState: { nodes: { a: { state: 'failed', error: 'boom' } } },
  });
  workflowRunsV2Repo.setStatus(run.id as ULID, 'failed', { lastReason: 'boom' });

  const collected: Array<{ sourceKind: string; sourceId: string }> = [];
  const actioned: ULID[][] = [];
  const opts = makeOpts(projectId, {
    reviewInbox: {
      collectUnactionedRecipients: (sourceKind, sourceId) => {
        collected.push({ sourceKind, sourceId });
        return ['r1', 'r2'] as unknown as ULID[];
      },
      actionRecipients: (ids) => actioned.push([...ids]),
    },
  });

  const result = await resumeFailedDagRun(run.id as ULID, WF, opts);
  assert.equal(result.ok, true, 'resume succeeds');

  assert.deepEqual(
    collected,
    [{ sourceKind: 'workflow-run', sourceId: run.id }],
    'collects the run-keyed failure cards',
  );
  assert.deepEqual(actioned, [[ 'r1', 'r2' ]], 'actions exactly the open snapshot');

  // The resume's diary line landed (= the next failure becomes incident 1).
  const resumes = workflowRunsV2Repo
    .listEvents(run.id as ULID)
    .filter((e) => e.type === 'run_resumed');
  assert.equal(resumes.length, 1, 'run_resumed diary line written');
});
