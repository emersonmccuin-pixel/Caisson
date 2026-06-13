// Phase 1.1 (pc-pty-chat-276.2) -- both review producers emit the unified
// ReviewPackage envelope.
//
// Tests:
//   1. workflow-gate requestReview: human flavor -> owner:human + valid package
//   2. workflow-gate requestReview: orchestrator flavor -> owner:orchestrator
//   3. verification-review mailbox: agent-verification producer, owner:human

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID, WorkflowV2 } from '@pc/domain';
import type { EnqueueMailboxMessageInput } from '@pc/db';
import type { AgentHostRunSnapshot } from '@pc/runtime';
import { isReviewPackage, parseReviewPackage } from '@pc/contracts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-rp-producers-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject,
  createOrchestratorSession,
  insertAgentRunRow,
  markAgentRunDelivered,
  newId,
  runMigrations,
} = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');
const { makeExecutorDeps } = await import('../src/services/dag-run-service.ts');
type DagRunServiceOptions = import('../src/services/dag-run-service.ts').DagRunServiceOptions;
const { WorkItemService } = await import('../src/services/work-item.ts');
const { WorktreeService } = await import('../src/services/worktree.ts');
const { applyHostTerminalSnapshot } = await import('../src/services/agent-host-reattach.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

// ---- helpers ---------------------------------------------------------------

function fakeMailbox() {
  const calls: EnqueueMailboxMessageInput[] = [];
  return { port: (input: EnqueueMailboxMessageInput) => (calls.push(input), {}), calls };
}

function reviewNode(reviewer: 'human' | 'orchestrator'): WorkflowV2.ReviewNode {
  return { id: 'review-1', kind: 'review', reviewer, reject: null };
}

const noopCtx = {
  runId: 'run-x' as ULID,
  rootWorkItemId: null as ULID | null,
  worktreePath: null as string | null,
  carry: {} as Record<string, string>,
  resolve: (_nodeId: string, _field?: string) => '',
};

// ---- 1. workflow-gate: human flavor -> owner:human -------------------------

test('workflow-gate requestReview emits valid ReviewPackage with owner:human', async () => {
  const slug = 'rp-wf-h-' + String(Date.now());
  const project = createProject({
    slug,
    name: 'RP WF Human',
    stages,
    folderPath: join(tmpDir, slug),
  });
  const runId = newId();
  const workflow: WorkflowV2.Workflow = {
    id: 'wf-rp-h',
    name: 'RP Workflow',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'coder', task: 'build' },
      { id: 'r', kind: 'review', reviewer: 'human', reject: null },
    ],
  };

  const calls: unknown[] = [];
  const opts: DagRunServiceOptions = {
    projectId: project.id as ULID,
    workspaceDir: project.folderPath,
    getProject: () => project,
    workItemService: new WorkItemService({
      projectId: project.id as ULID,
      getProject: () => project,
      getFieldSchemas: () => [],
    }),
    worktrees: new WorktreeService(project.folderPath, project.folderPath, async () => 'dev'),
    sessionDirFor: () => tmpDir,
    broadcast: () => {},
    deliverReview: (input) => { calls.push(input); return true; },
  };

  const deps = makeExecutorDeps(
    { id: runId as ULID, workItemId: null, worktreePath: null },
    workflow,
    opts,
  );

  await deps.requestReview(
    reviewNode('human'),
    noopCtx,
    [{ nodeId: 'a', output: 'Built the thing.' }],
    { iteration: 0, escalated: false },
  );

  assert.equal(calls.length, 1, 'deliverReview called once');
  const payload = (calls[0] as { payload?: { reviewPackage?: unknown } }).payload;
  assert.ok(payload?.reviewPackage, 'reviewPackage present in payload');

  const result = parseReviewPackage(payload.reviewPackage);
  assert.equal(result.ok, true, result.ok ? '' : (result as { error: string }).error);
  if (!result.ok) return;

  assert.equal(result.value.producer, 'workflow-gate');
  assert.equal(result.value.owner, 'human');
  assert.ok(isReviewPackage(payload.reviewPackage), 'isReviewPackage guard passes');
  assert.equal(result.value.work.kind, 'prose');
  assert.equal(result.value.provenance.workflowNodeId, 'review-1');
  assert.equal(result.value.provenance.workItemId, null);
});

// ---- 2. workflow-gate: orchestrator flavor -> owner:orchestrator ------------

test('workflow-gate requestReview emits valid ReviewPackage with owner:orchestrator', async () => {
  const slug = 'rp-wf-o-' + String(Date.now());
  const project = createProject({
    slug,
    name: 'RP WF Orch',
    stages,
    folderPath: join(tmpDir, slug),
  });
  const runId = newId();
  const workflow: WorkflowV2.Workflow = {
    id: 'wf-rp-o',
    name: 'RP Workflow Orch',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'coder', task: 'build' },
      { id: 'r', kind: 'review', reviewer: 'orchestrator', reject: null },
    ],
  };

  const calls: unknown[] = [];
  const opts: DagRunServiceOptions = {
    projectId: project.id as ULID,
    workspaceDir: project.folderPath,
    getProject: () => project,
    workItemService: new WorkItemService({
      projectId: project.id as ULID,
      getProject: () => project,
      getFieldSchemas: () => [],
    }),
    worktrees: new WorktreeService(project.folderPath, project.folderPath, async () => 'dev'),
    sessionDirFor: () => tmpDir,
    broadcast: () => {},
    deliverReview: (input) => { calls.push(input); return true; },
  };

  const deps = makeExecutorDeps(
    { id: runId as ULID, workItemId: null, worktreePath: null },
    workflow,
    opts,
  );

  await deps.requestReview(
    reviewNode('orchestrator'),
    noopCtx,
    [],
    { iteration: 1, escalated: false },
  );

  assert.equal(calls.length, 1, 'deliverReview called once');
  const payload = (calls[0] as { payload?: { reviewPackage?: unknown } }).payload;
  assert.ok(payload?.reviewPackage, 'reviewPackage present');

  const result = parseReviewPackage(payload.reviewPackage);
  assert.equal(result.ok, true, result.ok ? '' : (result as { error: string }).error);
  if (!result.ok) return;

  assert.equal(result.value.producer, 'workflow-gate');
  assert.equal(result.value.owner, 'orchestrator');
  assert.equal(result.value.attemptHistory.length, 1);
  assert.equal(result.value.attemptHistory[0]?.attempt, 2, 'iteration 1 -> attempt 2');
});

// ---- 3. agent verification-review ------------------------------------------

test('verification-review payload carries valid ReviewPackage (agent-verification, owner:human)', async () => {
  const slug = 'rp-vr-' + String(Date.now());
  const project = createProject({
    slug,
    name: 'RP VR',
    stages,
    folderPath: join(tmpDir, slug),
  });
  const session = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: 'cc-rp-vr-' + String(Date.now()),
  });
  const contract = new ContractService().create({
    projectId: project.id as ULID,
    workItemId: null,
    podName: 'builder',
    acceptanceCriteria: [],
    verificationTier: 'human-review',
  });
  const runId = newId();
  const ccSessionId = 'cc-rp-vr-' + String(Date.now());
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'builder',
    dispatcherSessionId: session.id,
    ccSessionId,
    status: 'running',
    input: 'go',
    queuedAt: Date.now(),
    contractId: contract.id as ULID,
  });
  markAgentRunDelivered(runId, Date.now());

  const mb = fakeMailbox();
  const t = Date.now();
  applyHostTerminalSnapshot(
    {
      runId,
      projectId: project.id,
      dispatcherSessionId: session.id,
      ccSessionId,
      podName: 'builder',
      worktreeDir: join(tmpDir, 'wt'),
      state: 'completed',
      jsonlPath: null,
      transcriptPath: null,
      queuedAt: t,
      spawnedAt: t,
      readyAt: t,
      updatedAt: t,
      terminalAt: t,
      terminalResult: { status: 'completed', result: 'done', failureCause: null, failureReason: null },
    } satisfies AgentHostRunSnapshot,
    { mailboxEnqueue: mb.port, broadcast: () => {}, terminalCleanup: () => {} },
  );
  await new Promise((r) => setTimeout(r, 200));

  const card = mb.calls.find((c) => c.message.kind === 'verification-review');
  assert.ok(card, 'verification-review card enqueued');

  const pkg = (card!.message.payload as { reviewPackage?: unknown }).reviewPackage;
  assert.ok(pkg, 'reviewPackage present in verification-review payload');

  const result = parseReviewPackage(pkg);
  assert.equal(result.ok, true, result.ok ? '' : (result as { error: string }).error);
  if (!result.ok) return;

  assert.equal(result.value.producer, 'agent-verification');
  assert.equal(result.value.owner, 'human');
  assert.ok(isReviewPackage(pkg), 'isReviewPackage guard passes');
  assert.equal(result.value.work.kind, 'prose');
  assert.equal(result.value.provenance.workflowNodeId, null);
  assert.equal(result.value.provenance.agentRunId, runId);
});
