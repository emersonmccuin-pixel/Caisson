// M5 slice A — the FD-5 round-trip guard (written BEFORE the body=brief-only
// move, per the ledger: "round-trip guard test FIRST").
//
// Pins the load-bearing semantics of the `$root.output` / contract-deliverable
// resolution so slice B's split is a DELIBERATE diff, not a silent break:
//
//  1. `$root.output` resolves the run-root card's BODY (the human brief) and
//     `$root.output.<field>` its typed fields. Survives slice B verbatim —
//     after the split the body is GUARANTEED to be the brief.
//  2. SLICE B LANDED (the deliberate amendment): ☠ store 'work_item_body' —
//     a prose deliverable lands on the contract row and the linked WI body
//     SURVIVES untouched (body = the human brief only, FD-5 law).
//  3. `$nodeId.output` reads the CONTRACT deliverable, never the WI body —
//     mutating the body after submission does not change the ref. Survives
//     slice B verbatim: downstream wiring never depended on the body write.
//  4. A node with no deliverable resolves to '' — task text can never leak
//     into a downstream input. Survives slice B verbatim.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-m5-roundtrip-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getWorkItem,
  updateWorkItemFields,
  insertAgentRunRow,
  newId,
} = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');
const { deriveAcceptanceCriteriaV2 } = await import('@pc/domain');
const { contractDeliverableText } = await import('@pc/contracts');
const { makeExecutorDeps } = await import('../src/services/dag-run-service.ts');
const { registerAgentRunRoutes } = await import('../src/features/agent-runs/routes.ts');

import type { Stage, ULID, ContractV2, WorkflowV2, Project } from '@pc/domain';
import type { DagRunServiceOptions } from '../src/services/dag-run-service.ts';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkProject(slug: string): Project {
  return createProject({ slug, name: slug, stages, folderPath: join(tmpDir, slug) });
}

function mkApp(): Hono {
  const app = new Hono();
  registerAgentRunRoutes(app, {
    broadcastTo: () => {},
    getActiveRunRegistry: () => ({ get: () => null }),
  });
  return app;
}

/** Resolver under test, built through the REAL deps factory (no parallel
 *  re-implementation of the resolution rules). Only `resolveRef` is exercised;
 *  the dispatch-side options are inert stubs. */
function mkResolver(project: Project, rootWorkItemId: ULID | null, state: WorkflowV2.WorkflowDagState) {
  const opts = {
    projectId: project.id as ULID,
    workspaceDir: tmpDir,
    getProject: () => project,
    workItemService: {},
    worktrees: {},
    sessionDirFor: () => tmpDir,
    broadcast: () => {},
  } as unknown as DagRunServiceOptions;
  const deps = makeExecutorDeps(
    {
      id: newId() as ULID,
      workItemId: rootWorkItemId,
      worktreePath: null,
      worktreeBaseBranch: null,
      worktreeBaseSha: null,
    },
    { name: 'm5-guard', nodes: [] } as unknown as WorkflowV2.Workflow,
    opts,
  );
  return deps.resolveRef(state);
}

/** Seed a dispatched prose contract + run on a child WI — what a workflow
 *  agent node mints in production. */
function seedProseChild(slug: string, store: 'contract' | undefined) {
  const p = mkProject(slug);
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'child task',
    body: 'TASK BRIEF — what the agent was told to do',
  });
  const expected: ContractV2.ExpectedOutput = {
    kind: 'prose',
    ...(store !== undefined ? { store } : {}),
    min_chars: 10,
  };
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: wi.id as ULID,
    podName: 'writer',
    expectedOutput: expected,
    acceptanceCriteria: deriveAcceptanceCriteriaV2(expected),
  });
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: p.id as ULID,
    podName: 'writer',
    dispatcherSessionId: 's',
    ccSessionId: 'cc',
    status: 'running',
    input: 'go',
    parentWorkItemId: wi.id,
    contractId: contract.id as ULID,
    queuedAt: Date.now(),
  });
  return { p, wi, contract, runId };
}

async function submit(app: Hono, projectId: string, runId: string, text: string) {
  return app.request(`/api/projects/${projectId}/agent-runs/${runId}/deliverable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliverable: { kind: 'prose', text } }),
  });
}

// ── 1. $root.output = the run-root card's body (the brief) ──────────────────

test('$root.output resolves the root card body; .field resolves typed fields', () => {
  const p = mkProject('m5-root');
  const root = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'root card',
    body: 'THE HUMAN BRIEF for this run',
    fields: { complexity: 'complex', count: 3 },
    isWorkflowRoot: true,
  });
  const resolve = mkResolver(p, root.id as ULID, { nodes: {} });

  assert.equal(resolve('root', undefined), 'THE HUMAN BRIEF for this run');
  assert.equal(resolve('root', 'complexity'), 'complex');
  assert.equal(resolve('root', 'count'), '3', 'non-string fields JSON-stringify');
  assert.equal(resolve('root', 'missing'), '', 'unknown field resolves empty');
});

test('$root.output with no root work item resolves empty', () => {
  const p = mkProject('m5-root-none');
  const resolve = mkResolver(p, null, { nodes: {} });
  assert.equal(resolve('root', undefined), '');
});

// ── 2. SLICE B law: the deliverable lands on the contract; the body SURVIVES ─
// (Amended from the pre-B pin of store=work_item_body's dual-write — the diff
// at commit time is the deliberate move.)

test('prose default store: deliverable lands on the contract row; the WI body stays the brief', async () => {
  const { p, wi, contract, runId } = seedProseChild('m5-wib', undefined);
  const app = mkApp();

  const text = 'THE DELIVERABLE — finished prose the agent produced';
  const res = await submit(app, p.id, runId, text);
  assert.equal(res.status, 200);

  // The contract row is the durable home (FD-5 law).
  const stored = new ContractService().listByWorkItem(wi.id as ULID).slice(-1)[0];
  assert.ok(stored?.deliverable, 'deliverable persisted on the contract row');
  assert.equal(contractDeliverableText(stored.deliverable, stored.report), text);
  assert.equal(stored.id, contract.id);

  // M5 law: body = the human brief only.
  assert.equal(
    getWorkItem(wi.id)!.body,
    'TASK BRIEF — what the agent was told to do',
    'the deliverable must never overwrite the WI body',
  );
});

// ── 3. $nodeId.output reads the CONTRACT, never the WI body ─────────────────

test('$nodeId.output resolves the contract deliverable; the WI body is irrelevant', async () => {
  const { p, wi, runId } = seedProseChild('m5-node', 'contract');
  const app = mkApp();

  const text = 'STEP OUTPUT read by the downstream node';
  const res = await submit(app, p.id, runId, text);
  assert.equal(res.status, 200);

  // Mutate the WI body AFTER submission — the ref must not move.
  updateWorkItemFields(wi.id, { body: 'body rewritten after delivery' });

  const resolve = mkResolver(p, null, { nodes: { step: { state: 'completed', workItemId: wi.id } } });
  assert.equal(resolve('step', undefined), text, '$nodeId.output reads the contract deliverable verbatim');
});

// ── 4. no deliverable → empty ref (task text can never leak downstream) ─────

test('$nodeId.output on a node with no deliverable resolves empty, not the task body', () => {
  const p = mkProject('m5-empty');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'never delivered',
    body: 'TASK BRIEF that must not leak',
  });
  const resolve = mkResolver(p, null, { nodes: { step: { state: 'failed', workItemId: wi.id } } });
  assert.equal(resolve('step', undefined), '');
});
