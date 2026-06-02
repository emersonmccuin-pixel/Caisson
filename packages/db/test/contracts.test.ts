// Slice 013 — agent_contracts migration applies, backfill is correct +
// idempotent, contracts repo CRUD + list-by-work-item + list-by-run, and the
// agent_runs.contract_id link round-trips.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  listContractsForRun,
  listContractsForWorkItem,
  newId,
  runMigrations,
  setAgentRunContractId,
  setContractDeliverable,
  setContractRun,
  setContractVerification,
} = await import('../src/index.ts');

const here = dirname(fileURLToPath(import.meta.url));
const backfillSql = readFileSync(
  join(here, '..', 'drizzle', '0038_agent_contracts.sql'),
  'utf8',
);

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];
function seedProject(slug: string) {
  return createProject({ slug, name: slug, stages, folderPath: '' });
}

/** Re-run ONLY the backfill statements (the INSERT … SELECT + the UPDATE) from
 *  the migration file. The CREATE TABLE / ALTER already ran in `before`. */
function runBackfillStatements(): void {
  const raw = getRawDb();
  for (const stmt of backfillSql.split('--> statement-breakpoint')) {
    // Strip leading whole-line `-- …` comments so we can detect the verb.
    const code = stmt.replace(/^\s*--[^\n]*\n/gm, '').trim();
    if (/^(INSERT|UPDATE)\b/i.test(code)) raw.exec(code);
  }
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

test('backfill produces one contract per is_agent_task WI with correct field copy + link', () => {
  const p = seedProject('backfill');
  const raw = getRawDb();
  const wiId = newId();
  const runId = newId();
  const now = Date.now();
  const eo = JSON.stringify({ kind: 'answer', min_chars: 5 });
  const ac = JSON.stringify([{ kind: 'report_contains', pattern: 'ok' }]);

  // Legacy is_agent_task WI with contract columns + a run linked both ways.
  raw.prepare(
    `INSERT INTO work_items
      (id, project_id, parent_id, title, body, stage_id, status, type, fields, history,
       position, version, is_agent_task, is_workflow_root, ephemeral,
       acceptance_criteria, expected_output, verification_tier, verification_status,
       verification_notes, assigned_agent_run_id, worktree_path, callsign, area_id,
       created_at, updated_at, deleted_at)
     VALUES
      (?, ?, NULL, 'Contract WI', 'task body', 'todo', 'in-progress', 'task', '{}', '[]',
       0, 1, 1, 0, 0, ?, ?, 'auto', NULL, NULL, ?, '/wt/x', NULL, NULL, ?, ?, NULL)`,
  ).run(wiId, p.id, ac, eo, runId, now, now);

  insertAgentRunRow({
    id: runId,
    projectId: p.id,
    podName: 'researcher',
    dispatcherSessionId: 'sess-1',
    ccSessionId: 'cc-1',
    status: 'completed',
    input: 'go',
    parentWorkItemId: wiId,
    queuedAt: now,
  });

  // A non-agent WI must NOT get a contract.
  const plainWi = newId();
  raw.prepare(
    `INSERT INTO work_items
      (id, project_id, parent_id, title, body, stage_id, status, type, fields, history,
       position, version, is_agent_task, is_workflow_root, ephemeral, created_at, updated_at)
     VALUES (?, ?, NULL, 'Plain', '', 'todo', 'todo', 'task', '{}', '[]', 0, 1, 0, 0, 0, ?, ?)`,
  ).run(plainWi, p.id, now, now);

  runBackfillStatements();

  const contracts = listContractsForWorkItem(wiId);
  assert.equal(contracts.length, 1, 'exactly one contract for the agent-task WI');
  const c = contracts[0]!;
  assert.equal(c.id, wiId, 'deterministic id == work item id');
  assert.equal(c.projectId, p.id);
  assert.equal(c.workItemId, wiId);
  assert.equal(c.agentRunId, runId);
  assert.deepEqual(c.expectedOutput, { kind: 'answer', min_chars: 5 });
  assert.deepEqual(c.acceptanceCriteria, [{ kind: 'report_contains', pattern: 'ok' }]);
  assert.equal(c.verificationTier, 'auto');
  assert.equal(c.worktreePath, '/wt/x');
  assert.equal(c.status, 'dispatched');

  // The plain WI got nothing.
  assert.equal(listContractsForWorkItem(plainWi).length, 0);

  // The run's contract_id was backfilled.
  const runRow = raw
    .prepare('SELECT contract_id FROM agent_runs WHERE id = ?')
    .get(runId) as { contract_id: string | null };
  assert.equal(runRow.contract_id, wiId);

  // And list-by-run resolves it.
  const byRun = listContractsForRun(runId);
  assert.equal(byRun.length, 1);
  assert.equal(byRun[0]!.id, wiId);
});

test('backfill is idempotent on re-run (no duplicate rows, link stays)', () => {
  const raw = getRawDb();
  const before = (raw.prepare('SELECT COUNT(*) AS n FROM agent_contracts').get() as { n: number }).n;
  runBackfillStatements();
  runBackfillStatements();
  const afterCount = (raw.prepare('SELECT COUNT(*) AS n FROM agent_contracts').get() as { n: number }).n;
  assert.equal(afterCount, before, 're-running the backfill must not add rows');
});

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
       position, version, is_agent_task, is_workflow_root, ephemeral, created_at, updated_at)
     VALUES (?, ?, NULL, 'WI', '', 'todo', 'todo', 'task', '{}', '[]', 0, 1, 1, 0, 0, ?, ?)`,
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
