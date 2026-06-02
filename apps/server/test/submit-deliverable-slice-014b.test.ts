// Slice 014b — submission-gated completion + pc_submit_deliverable.
//
// Coverage:
//   - POST /agent-runs/:runId/deliverable writes the typed deliverable onto the
//     run's contract (status -> submitted); resolves the contract from
//     agent_runs.contract_id.
//   - kind-match guard: a deliverable whose kind != the contract's expected
//     output kind is rejected 400.
//   - shape validation: a malformed deliverable is rejected 400.
//   - submission-gated capture: a SUBMITTED deliverable is authoritative —
//     terminal effects do NOT overwrite it with the wi.body scrape.
//   - hasPendingAskForRun is any-status (powers pending_ask_created).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-submit-deliverable-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getContract,
  insertAgentRunRow,
  createPendingAsk,
  hasPendingAskForRun,
  hasOpenPendingAskForRun,
  markPendingAskAnswered,
  newId,
} = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');

import type { Stage, ULID } from '@pc/domain';
import { registerAgentRunRoutes } from '../src/features/agent-runs/routes.ts';
import { applyAgentRunTerminalEffects } from '../src/services/agent-run-terminal-effects.ts';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkProject(slug: string) {
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

function seedRunWithContract(slug: string, expectedOutput?: unknown) {
  const p = mkProject(slug);
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    podName: 'researcher',
    ...(expectedOutput !== undefined
      ? { expectedOutput: expectedOutput as Parameters<ContractService['create']>[0]['expectedOutput'] }
      : {}),
  });
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 's',
    ccSessionId: 'cc',
    status: 'running',
    input: 'go',
    contractId: contract.id as ULID,
    queuedAt: Date.now(),
  });
  return { p, contract, runId };
}

test('submit writes the typed deliverable onto the run contract (status submitted)', async () => {
  const { p, contract, runId } = seedRunWithContract('sd-answer', { kind: 'answer' });
  const app = mkApp();
  const res = await app.request(`/api/projects/${p.id}/agent-runs/${runId}/deliverable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliverable: { kind: 'answer', text: 'Node LTS is 22.' }, report: 'done' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; contractId: string; status: string };
  assert.equal(body.ok, true);
  assert.equal(body.contractId, contract.id);
  assert.equal(body.status, 'submitted');

  const updated = getContract(contract.id as ULID);
  assert.deepEqual(updated!.deliverable, { kind: 'answer', text: 'Node LTS is 22.' });
  assert.equal(updated!.report, 'done');
});

test('kind-match guard: deliverable kind must match the contract expected output', async () => {
  const { p, runId } = seedRunWithContract('sd-kindmatch', { kind: 'answer' });
  const app = mkApp();
  const res = await app.request(`/api/projects/${p.id}/agent-runs/${runId}/deliverable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliverable: { kind: 'repo', branch: 'feat/x' } }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; cause: string };
  assert.equal(body.cause, 'kind-mismatch');
});

test('shape validation: a malformed deliverable is rejected', async () => {
  const { p, runId } = seedRunWithContract('sd-shape', { kind: 'answer' });
  const app = mkApp();
  const res = await app.request(`/api/projects/${p.id}/agent-runs/${runId}/deliverable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliverable: { kind: 'answer' } }), // missing text
  });
  assert.equal(res.status, 400);
});

test('contract with no expected output kind accepts any deliverable kind', async () => {
  const { p, contract, runId } = seedRunWithContract('sd-nokind'); // no expectedOutput
  const app = mkApp();
  const res = await app.request(`/api/projects/${p.id}/agent-runs/${runId}/deliverable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliverable: { kind: 'action', tool: 'pc_ask_user', count: 1 } }),
  });
  assert.equal(res.status, 200);
  const updated = getContract(contract.id as ULID);
  assert.deepEqual(updated!.deliverable, { kind: 'action', tool: 'pc_ask_user', count: 1 });
});

test('submission-gated capture: a submitted deliverable is NOT overwritten by wi.body', () => {
  const p = mkProject('sd-gated');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'c',
    body: 'STALE body that must NOT become the deliverable',
    isAgentTask: true,
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: wi.id,
    podName: 'writer',
  });
  // Agent submitted its real deliverable.
  new ContractService().setDeliverable({
    id: contract.id as ULID,
    deliverable: { kind: 'answer', text: 'the real submitted answer' },
    report: 'the real submitted answer',
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

  applyAgentRunTerminalEffects(
    {
      runId,
      ccSessionId: 'cc',
      podName: 'writer',
      projectId: p.id as ULID,
      dispatcherSessionId: 's',
      parentWorkItemId: wi.id,
      worktreeDir: join(tmpDir, 'sd-gated'),
      status: 'completed',
      result: '', // empty: legacy path would scrape wi.body — submission must win
      completedAt: Date.now(),
      startedAt: Date.now(),
      workItemId: wi.id,
      contractId: contract.id as ULID,
    },
    {},
  );

  const updated = getContract(contract.id as ULID);
  assert.deepEqual(updated!.deliverable, { kind: 'answer', text: 'the real submitted answer' });
});

test('legacy fallback still writes wi.body when nothing was submitted', () => {
  const p = mkProject('sd-legacy');
  const wi = createWorkItem({
    projectId: p.id as ULID,
    stageId: 'backlog',
    title: 'c',
    body: 'body becomes the deliverable when no submission',
    isAgentTask: true,
    acceptanceCriteria: [],
    verificationTier: 'auto',
  });
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: wi.id,
    podName: 'writer',
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

  applyAgentRunTerminalEffects(
    {
      runId,
      ccSessionId: 'cc',
      podName: 'writer',
      projectId: p.id as ULID,
      dispatcherSessionId: 's',
      parentWorkItemId: wi.id,
      worktreeDir: join(tmpDir, 'sd-legacy'),
      status: 'completed',
      result: '',
      completedAt: Date.now(),
      startedAt: Date.now(),
      workItemId: wi.id,
      contractId: contract.id as ULID,
    },
    {},
  );

  const updated = getContract(contract.id as ULID);
  assert.deepEqual(updated!.deliverable, {
    kind: 'answer',
    text: 'body becomes the deliverable when no submission',
  });
});

test('hasPendingAskForRun is any-status (open AND answered), unlike hasOpenPendingAskForRun', () => {
  const p = mkProject('sd-pending');
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 's',
    ccSessionId: 'cc-pending',
    status: 'running',
    input: 'go',
    queuedAt: Date.now(),
  });
  const askId = newId() as ULID;
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: 'cc-pending',
    projectId: p.id as ULID,
    kind: 'user',
    promptBody: 'need input',
    now: Date.now(),
  });
  assert.equal(hasPendingAskForRun(runId), true);
  assert.equal(hasOpenPendingAskForRun(runId), true);

  // Answer it -> open flips to answered. hasPendingAskForRun still true.
  markPendingAskAnswered({ id: askId, answer: 'here', answeredBy: 'user', now: Date.now() });
  assert.equal(hasOpenPendingAskForRun(runId), false);
  assert.equal(hasPendingAskForRun(runId), true);
});

test('submit 404s on unknown run / 409s when the run has no contract', async () => {
  const p = mkProject('sd-errors');
  const app = mkApp();

  const noRun = await app.request(`/api/projects/${p.id}/agent-runs/${newId()}/deliverable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliverable: { kind: 'answer', text: 'x' } }),
  });
  assert.equal(noRun.status, 404);

  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 's',
    ccSessionId: 'cc',
    status: 'running',
    input: 'go',
    queuedAt: Date.now(),
  });
  const noContract = await app.request(`/api/projects/${p.id}/agent-runs/${runId}/deliverable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliverable: { kind: 'answer', text: 'x' } }),
  });
  assert.equal(noContract.status, 409);
});
