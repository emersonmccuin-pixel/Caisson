// Slice 013 — agent_contracts migration applies, backfill is correct +
// idempotent, contracts repo CRUD + list-by-work-item + list-by-run, and the
// agent_runs.contract_id link round-trips.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-contracts-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  assertSchemaIntact,
  closeDb,
  createContract,
  createProject,
  getContract,
  getRawDb,
  insertAgentRunRow,
  listContractsForWorkItem,
  newId,
  runMigrations,
  setAgentRunContractId,
  setContractDeliverable,
  setContractRun,
  setContractVerification,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];
function seedProject(slug: string) {
  return createProject({ slug, name: slug, stages, folderPath: '' });
}

test('0038 creates agent_contracts table with every schema.ts column', () => {
  const raw = getRawDb();
  const cols = (raw.pragma('table_info("agent_contracts")') as { name: string }[]).map(
    (c) => c.name,
  );
  for (const col of [
    'id', 'project_id', 'work_item_id', 'agent_run_id', 'attempt', 'issued_by',
    'pod_name', 'expected_output', 'acceptance_criteria', 'verification_tier',
    'verification_status', 'verification_notes', 'report', 'deliverable',
    'worktree_path', 'status', 'version', 'created_at', 'updated_at',
  ]) {
    assert.ok(cols.includes(col), `agent_contracts.${col} should exist`);
  }
  const runCols = (raw.pragma('table_info("agent_runs")') as { name: string }[]).map(
    (c) => c.name,
  );
  assert.ok(runCols.includes('contract_id'), 'agent_runs.contract_id should exist');
});

test('assertSchemaIntact does not throw after a fresh migrate', () => {
  assert.doesNotThrow(() => assertSchemaIntact());
});

// Slice 023 — the historical 0038 backfill (one contract per legacy
// is_agent_task WI) ran once before migration 0039 dropped those work_items
// columns. The columns no longer exist on a fresh DB, so the backfill can't be
// re-exercised; its tests were removed with the columns.

test('contracts repo: create / setRun / setDeliverable / setVerification + version bumps', () => {
  const p = seedProject('crud');
  const c0 = createContract({
    projectId: p.id,
    workItemId: null,
    podName: 'writer',
    issuedBy: 'orch-1',
    expectedOutput: { kind: 'prose', doc_type: 'prd' },
    acceptanceCriteria: [{ kind: 'body_contains', pattern: 'Goals' }],
    verificationTier: 'auto',
  });
  assert.equal(c0.status, 'issued');
  assert.equal(c0.version, 1);
  assert.equal(c0.workItemId, null);
  assert.equal(c0.deliverable, null);

  const runId = newId();
  const c1 = setContractRun(c0.id, runId);
  assert.ok(c1);
  assert.equal(c1!.agentRunId, runId);
  assert.equal(c1!.status, 'dispatched');
  assert.equal(c1!.version, 2);

  const c2 = setContractDeliverable(c0.id, {
    deliverable: { kind: 'prose', text: '## Goals' },
    report: 'wrote the PRD',
  });
  assert.ok(c2);
  assert.deepEqual(c2!.deliverable, { kind: 'prose', text: '## Goals' });
  assert.equal(c2!.report, 'wrote the PRD');
  assert.equal(c2!.status, 'submitted');
  assert.equal(c2!.version, 3);

  const c3 = setContractVerification(c0.id, { verificationStatus: 'passed' });
  assert.ok(c3);
  assert.equal(c3!.verificationStatus, 'passed');
  assert.equal(c3!.status, 'accepted');
  assert.equal(c3!.version, 4);

  // round-trips through getContract
  const fetched = getContract(c0.id);
  assert.deepEqual(fetched, c3);

  // missing-id mutations return null
  assert.equal(setContractDeliverable('nope', { deliverable: null }), null);
  assert.equal(setContractVerification('nope', { verificationStatus: 'failed' }), null);
});

test('many contracts : one work item (1:many), ordered oldest-first', () => {
  const p = seedProject('many');
  const raw = getRawDb();
  const wiId = newId();
  const now = Date.now();
  raw.prepare(
    `INSERT INTO work_items
      (id, project_id, parent_id, title, body, stage_id, status, type, fields, history,
       position, version, is_workflow_root, created_at, updated_at)
     VALUES (?, ?, NULL, 'WI', '', 'todo', 'todo', 'task', '{}', '[]', 0, 1, 0, ?, ?)`,
  ).run(wiId, p.id, now, now);

  const a = createContract({ projectId: p.id, workItemId: wiId, podName: 'a' });
  const b = createContract({ projectId: p.id, workItemId: wiId, podName: 'b' });
  const list = listContractsForWorkItem(wiId);
  assert.equal(list.length, 2);
  // created oldest-first
  assert.deepEqual(
    list.map((c) => c.id),
    [a.id, b.id],
  );
});

test('agent_runs.contract_id round-trips via insert + setter', () => {
  const p = seedProject('runlink');
  const runId = newId();
  const contractId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: p.id,
    podName: 'x',
    dispatcherSessionId: 's',
    ccSessionId: 'cc',
    status: 'queued',
    input: null,
    contractId,
    queuedAt: Date.now(),
  });
  const raw = getRawDb();
  let row = raw.prepare('SELECT contract_id FROM agent_runs WHERE id = ?').get(runId) as {
    contract_id: string | null;
  };
  assert.equal(row.contract_id, contractId);

  setAgentRunContractId(runId, null);
  row = raw.prepare('SELECT contract_id FROM agent_runs WHERE id = ?').get(runId) as {
    contract_id: string | null;
  };
  assert.equal(row.contract_id, null);
});
