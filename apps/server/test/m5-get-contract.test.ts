// M5 slice D — `pc_get_contract`'s server half: GET
// /api/projects/:projectId/agent-runs/:runId/contract returns the agent-facing
// contract view INCLUDING the acceptance criteria (the FD-5 addendum gap: the
// verification predicates were invisible to the agent, so it couldn't
// self-check before submitting).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-m5-getcontract-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createProject, insertAgentRunRow, newId } = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');
const { deriveAcceptanceCriteriaV2 } = await import('@pc/domain');
const { registerAgentRunRoutes } = await import('../src/features/agent-runs/routes.ts');

import type { Stage, ULID, ContractV2 } from '@pc/domain';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkApp(): Hono {
  const app = new Hono();
  registerAgentRunRoutes(app, {
    broadcastTo: () => {},
    getActiveRunRegistry: () => ({ get: () => null }),
  });
  return app;
}

function seedRun(slug: string, opts: { withContract: boolean }) {
  const p = createProject({ slug, name: slug, stages, folderPath: join(tmpDir, slug) });
  const expected: ContractV2.ExpectedOutput = {
    kind: 'prose',
    sections: ['Findings'],
    min_chars: 25,
  };
  const contract = opts.withContract
    ? new ContractService().create({
        projectId: p.id as ULID,
        workItemId: null,
        podName: 'writer',
        expectedOutput: expected,
        acceptanceCriteria: deriveAcceptanceCriteriaV2(expected),
      })
    : null;
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: p.id as ULID,
    podName: 'writer',
    dispatcherSessionId: 's',
    ccSessionId: 'cc',
    status: 'running',
    input: 'go',
    ...(contract ? { contractId: contract.id as ULID } : {}),
    queuedAt: Date.now(),
  });
  return { p, contract, runId };
}

test('GET contract returns the agent-facing view INCLUDING acceptance criteria', async () => {
  const { p, contract, runId } = seedRun('m5gc', { withContract: true });
  const app = mkApp();

  const res = await app.request(`/api/projects/${p.id}/agent-runs/${runId}/contract`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    contract: {
      id: string;
      status: string;
      expectedOutput: { kind: string };
      acceptanceCriteria: Array<{ kind: string }>;
    };
  };
  assert.equal(body.ok, true);
  assert.equal(body.contract.id, contract!.id);
  assert.equal(body.contract.expectedOutput.kind, 'prose');
  // THE addendum requirement: the predicates are readable by the agent.
  assert.ok(Array.isArray(body.contract.acceptanceCriteria));
  assert.ok(
    body.contract.acceptanceCriteria.length > 0,
    'derived AC must be present on the agent-facing view',
  );
});

test('GET contract on a contract-less run is a typed 409', async () => {
  const { p, runId } = seedRun('m5gc-none', { withContract: false });
  const app = mkApp();

  const res = await app.request(`/api/projects/${p.id}/agent-runs/${runId}/contract`);
  assert.equal(res.status, 409);
  const body = (await res.json()) as { ok: boolean; cause: string };
  assert.equal(body.ok, false);
  assert.equal(body.cause, 'no-contract');
});

test('GET contract on an unknown run is 404', async () => {
  const { p } = seedRun('m5gc-404', { withContract: true });
  const app = mkApp();

  const res = await app.request(`/api/projects/${p.id}/agent-runs/${newId()}/contract`);
  assert.equal(res.status, 404);
});
