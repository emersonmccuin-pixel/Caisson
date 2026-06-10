// Slice 4 (FD-5 principle 3b) — Read-door guardrail test.
//
// Fences: an orchestrator session (no PC_AGENT_RUN_ID) can read the authoritative
// deliverable via pc_get_deliverable by contract id AND by work-item id.
// A contract-only dispatch (no linked WI) is the primary case — proves the route
// works without a work item.
//
// Three axes:
//   (1) Contract-only (no WI): resolve by contract id → deliverable + report.
//   (2) Contract linked to WI: resolve by work-item id → same deliverable.
//   (3) Project guard: same contract id from the wrong project → 404.
//   (4) Unknown id: 404.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-get-deliverable-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  newId,
} = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');
const { registerAgentRunRoutes } = await import('../src/features/agent-runs/routes.ts');

import type { Stage, ULID } from '@pc/domain';

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

// ── (1) Contract-only dispatch (no linked WI): resolve by contract id ─────────

test('Read-door: contract-only dispatch — by contract id returns deliverable + report', async () => {
  const p = createProject({ slug: 'gd-1', name: 'gd-1', stages, folderPath: join(tmpDir, 'gd-1') });
  const svc = new ContractService();

  // Create contract, submit a deliverable.
  const contract = svc.create({ projectId: p.id as ULID, podName: 'researcher' });
  svc.setDeliverable({
    id: contract.id as ULID,
    deliverable: { kind: 'answer', text: 'The answer is 42.' },
    report: 'done cleanly',
  });

  const app = mkApp();
  const res = await app.request(`/api/projects/${p.id}/contracts/${contract.id}/deliverable`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    deliverable: { kind: string; text: string } | null;
    report: string | null;
    status: string;
    expectedOutput: unknown;
  };
  assert.equal(body.ok, true);
  assert.deepEqual(body.deliverable, { kind: 'answer', text: 'The answer is 42.' });
  assert.equal(body.report, 'done cleanly');
  assert.equal(typeof body.status, 'string');
});

// ── (2) Contract linked to WI: resolve by work-item id ───────────────────────

test('Read-door: contract linked to WI — by work-item id returns deliverable', async () => {
  const p = createProject({ slug: 'gd-2', name: 'gd-2', stages, folderPath: join(tmpDir, 'gd-2') });
  const wi = createWorkItem({ projectId: p.id as ULID, stageId: 'backlog', title: 'task', body: 'do it' });
  const svc = new ContractService();

  const contract = svc.create({
    projectId: p.id as ULID,
    workItemId: wi.id as ULID,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo' },
  });
  svc.setDeliverable({
    id: contract.id as ULID,
    deliverable: { kind: 'repo', branch: 'feat/gd-2', commit: 'abc123' },
    report: 'branch pushed',
  });

  const app = mkApp();
  // Resolve by work-item id.
  const res = await app.request(`/api/projects/${p.id}/contracts/${wi.id}/deliverable`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    deliverable: { kind: string } | null;
    report: string | null;
    expectedOutput: { kind: string } | null;
  };
  assert.equal(body.ok, true);
  assert.deepEqual(body.deliverable, { kind: 'repo', branch: 'feat/gd-2', commit: 'abc123' });
  assert.equal(body.report, 'branch pushed');
  assert.equal(body.expectedOutput?.kind, 'repo');
});

// ── (3) Project guard: wrong project → 404 ────────────────────────────────────

test('Read-door: project guard — contract from another project is 404', async () => {
  const pA = createProject({ slug: 'gd-3a', name: 'gd-3a', stages, folderPath: join(tmpDir, 'gd-3a') });
  const pB = createProject({ slug: 'gd-3b', name: 'gd-3b', stages, folderPath: join(tmpDir, 'gd-3b') });
  const svc = new ContractService();

  // Contract belongs to pA.
  const contract = svc.create({ projectId: pA.id as ULID, podName: 'researcher' });
  svc.setDeliverable({
    id: contract.id as ULID,
    deliverable: { kind: 'answer', text: 'private' },
  });

  // pB tries to read it.
  const app = mkApp();
  const res = await app.request(`/api/projects/${pB.id}/contracts/${contract.id}/deliverable`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { ok: boolean; cause: string };
  assert.equal(body.ok, false);
});

// ── (4) Unknown id → 404 ──────────────────────────────────────────────────────

test('Read-door: unknown id → 404', async () => {
  const p = createProject({ slug: 'gd-4', name: 'gd-4', stages, folderPath: join(tmpDir, 'gd-4') });
  const app = mkApp();
  const res = await app.request(`/api/projects/${p.id}/contracts/${newId()}/deliverable`);
  assert.equal(res.status, 404);
});

// ── (5) Null deliverable when not yet submitted ────────────────────────────────

test('Read-door: null deliverable when agent has not yet submitted', async () => {
  const p = createProject({ slug: 'gd-5', name: 'gd-5', stages, folderPath: join(tmpDir, 'gd-5') });
  const svc = new ContractService();
  const contract = svc.create({ projectId: p.id as ULID, podName: 'researcher' });
  // No setDeliverable call.

  const app = mkApp();
  const res = await app.request(`/api/projects/${p.id}/contracts/${contract.id}/deliverable`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; deliverable: unknown };
  assert.equal(body.ok, true);
  assert.equal(body.deliverable, null);
});
