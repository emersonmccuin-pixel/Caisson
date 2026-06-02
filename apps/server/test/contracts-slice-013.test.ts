// Slice 013 — server wiring for first-class agent contracts.
//
// Coverage:
//   - createAgentWorkItem mints a linked contract (work-log row) alongside the WI.
//   - verification reads AC THROUGH the contract shim and STILL flips the WI
//     exactly as before (byte-identical mechanism; data source moved).
//   - terminal effects write the deliverable onto the contract (no wi.body
//     fallback live-read — the deliverable has a home).
//   - routes return the work-log timeline + the contract detail.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-contracts-server-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getWorkItem,
  getContract,
  insertAgentRunRow,
  listContractsForWorkItem,
  newId,
} = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');

import type { Stage, ULID } from '@pc/domain';
import { Hono } from 'hono';
import { runVerificationOnTerminal } from '../src/services/agent-verification.ts';
import { applyAgentRunTerminalEffects } from '../src/services/agent-run-terminal-effects.ts';
import { createAgentWorkItem } from '../src/services/agent-work-item.ts';
import { WorkItemService } from '../src/services/work-item.ts';
import { registerContractRoutes } from '../src/features/contracts/routes.ts';

const stages: Stage[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'doing', name: 'Doing', order: 1 },
];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkProject(slug: string) {
  return createProject({ slug, name: slug, stages, folderPath: tmpDir });
}

// ── createAgentWorkItem mints a linked contract ──────────────────────────────

test('createAgentWorkItem creates a contract linked to the WI', () => {
  const p = mkProject('caw-contract');
  const svc = new WorkItemService({
    projectId: p.id as ULID,
    getProject: () => p,
    getFieldSchemas: () => [],
  });
  const contractService = new ContractService();
  const wi = createAgentWorkItem(
    {
      title: 'Do the thing',
      task: 'go do it',
      pod: 'researcher',
      expectedOutput: { kind: 'text', min_chars: 5 },
      verificationTier: 'auto',
    },
    {
      workItemService: svc,
      getProject: () => p,
      contractService,
    },
  );
  const contracts = listContractsForWorkItem(wi.id);
  assert.equal(contracts.length, 1, 'one contract minted for the agent WI');
  assert.equal(contracts[0]!.workItemId, wi.id);
  assert.equal(contracts[0]!.podName, 'researcher');
  assert.equal(contracts[0]!.verificationTier, 'auto');
});

// ── verification reads AC from the contract; WI advance is a roll-up ──────────

test('verification sources AC from the contract and rolls up the linked WI', async () => {
  const p = mkProject('verify-shim');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'c',
    body: 'no needle here',
    isAgentTask: true,
    verificationTier: 'auto',
  });
  // Contract for this WI with EMPTY AC → passes → roll up the WI to complete.
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: wi.id,
    podName: 'x',
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });

  const outcome = await runVerificationOnTerminal({
    contractId: contract.id as ULID,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
  });
  assert.ok(outcome);
  assert.equal(outcome!.verificationStatus, 'passed');
  // Contract accepted; the linked WI rolled up to complete.
  assert.equal(getContract(contract.id as ULID)!.status, 'accepted');
  assert.equal(getWorkItem(wi.id)!.status, 'complete');
});

test('verification is a no-op when no contract id is supplied', async () => {
  const outcome = await runVerificationOnTerminal({
    contractId: null,
    terminalStatus: 'completed',
    failureReason: null,
    projectFolderPath: tmpDir,
    worktreeDir: tmpDir,
  });
  assert.equal(outcome, null);
});

// ── terminal effects write the deliverable onto the contract ─────────────────

test('terminal effects write the answer deliverable onto the contract', () => {
  const p = mkProject('terminal-deliverable');
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: null,
    podName: 'writer',
  });
  const runId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: p.id as ULID,
    podName: 'writer',
    dispatcherSessionId: 's',
    ccSessionId: 'cc',
    status: 'running',
    input: 'go',
    contractId: contract.id as ULID,
    queuedAt: Date.now(),
  });

  const res = applyAgentRunTerminalEffects(
    {
      runId,
      ccSessionId: 'cc',
      podName: 'writer',
      projectId: p.id as ULID,
      dispatcherSessionId: 's',
      parentWorkItemId: null,
      worktreeDir: tmpDir,
      status: 'completed',
      result: 'the final report',
      completedAt: Date.now(),
      startedAt: Date.now(),
      contractId: contract.id as ULID,
    },
    {},
  );
  assert.equal(res.applied, 1);
  const updated = getContract(contract.id as ULID);
  assert.ok(updated);
  assert.deepEqual(updated!.deliverable, { kind: 'answer', text: 'the final report' });
  assert.equal(updated!.report, 'the final report');
  // Slice 020 — the contract's terminal status (submitted → accepted via the
  // async verification tail) is asserted deterministically in
  // verification-slice-020.test.ts; this test pins the synchronous capture.
});

test('terminal effects: empty result with no submission writes NO deliverable (wi.body fallback retired)', () => {
  const p = mkProject('terminal-wibody');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'c',
    body: 'deliverable written into the body',
    isAgentTask: true,
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: wi.id,
    podName: 'writer',
  });
  const runId = newId();
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

  applyAgentRunTerminalEffects(
    {
      runId,
      ccSessionId: 'cc',
      podName: 'writer',
      projectId: p.id as ULID,
      dispatcherSessionId: 's',
      parentWorkItemId: wi.id,
      worktreeDir: tmpDir,
      status: 'completed',
      result: '', // empty + no submission → no deliverable synthesized
      completedAt: Date.now(),
      startedAt: Date.now(),
      workItemId: wi.id,
      contractId: contract.id as ULID,
    },
    {},
  );
  const updated = getContract(contract.id as ULID);
  // No wi.body borrow: the deliverable stays null.
  assert.equal(updated!.deliverable, null);
});

// ── routes ───────────────────────────────────────────────────────────────────

test('routes: /work-items/:id/contracts timeline + /contracts/:id detail', async () => {
  const p = mkProject('routes');
  const service = new ContractService();
  const wiId = newId() as ULID;
  const a = service.create({ projectId: p.id as ULID, workItemId: wiId, podName: 'a' });
  const b = service.create({ projectId: p.id as ULID, workItemId: wiId, podName: 'b' });

  const app = new Hono();
  registerContractRoutes(app, { contractService: service });

  const timeline = await app.request(`/api/work-items/${wiId}/contracts`);
  assert.equal(timeline.status, 200);
  const timelineBody = (await timeline.json()) as { ok: true; contracts: { id: string }[] };
  assert.equal(timelineBody.ok, true);
  assert.deepEqual(timelineBody.contracts.map((c) => c.id), [a.id, b.id]);

  const detail = await app.request(`/api/contracts/${a.id}`);
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as { ok: true; contract: { id: string } };
  assert.equal(detailBody.contract.id, a.id);

  const missing = await app.request('/api/contracts/nope');
  assert.equal(missing.status, 404);

  // Empty work-log → ok with empty array (not 404).
  const empty = await app.request(`/api/work-items/${newId()}/contracts`);
  assert.equal(empty.status, 200);
  const emptyBody = (await empty.json()) as { ok: true; contracts: unknown[] };
  assert.deepEqual(emptyBody.contracts, []);
});
