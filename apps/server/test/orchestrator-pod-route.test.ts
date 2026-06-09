// pc-pty-chat-359 P4a — Tests for GET /api/projects/:id/orchestrator-pod.
//
// Verifies that the endpoint resolves the orchestrator pod for a given project
// and returns its agentId, or 404 when the pod is not seeded.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-orch-pod-route-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createAgent, createProject } = await import('@pc/db');
const { registerMcpServerRoutes } = await import('../src/features/mcp-servers/routes.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp() {
  const app = new Hono();
  registerMcpServerRoutes(app, {});
  return app;
}

function makeProject(slug: string) {
  return createProject({
    slug,
    name: 'Test Project',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: '/tmp/test',
  });
}

test('GET /orchestrator-pod — 404 for unknown project', async () => {
  const app = makeApp();
  const res = await app.request('/api/projects/01NOTEXIST0000000000000000/orchestrator-pod');
  assert.equal(res.status, 404);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /unknown project/);
});

test('GET /orchestrator-pod — 404 when orchestrator pod not seeded', async () => {
  const app = makeApp();
  const project = makeProject('orch-pod-no-pod-' + Date.now());
  const res = await app.request(`/api/projects/${project.id}/orchestrator-pod`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /orchestrator pod not found/);
});

test('GET /orchestrator-pod — 200 with agentId when global orchestrator pod exists', async () => {
  const app = makeApp();
  const project = makeProject('orch-pod-with-pod-' + Date.now());
  // Seed a global 'orchestrator' stock pod (mirrors seedOrchestratorPodIfMissing).
  // origin: 'stock' is required — isProjectDispatchable only passes stock globals.
  const agent = createAgent(
    { name: 'orchestrator', scope: 'global', origin: 'stock', prompt: 'Test orchestrator' },
    { actor: 'system', reason: 'test-seed' },
  );
  const res = await app.request(`/api/projects/${project.id}/orchestrator-pod`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; agentId: string };
  assert.equal(body.ok, true);
  assert.equal(body.agentId, agent.id);
});
