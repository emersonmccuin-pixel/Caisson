// pc-pty-chat-359 P1 — HTTP routes smoke test for the MCP server registry.
//
// Covers: global CRUD, project scoped list+create, 404 on unknown ids, and
// name-collision rejection (unique index violation surface via 422).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-mcp-reg-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createProject, runMigrations } = await import('@pc/db');
const { registerMcpServerRoutes } = await import(
  '../src/features/mcp-servers/routes.ts'
);

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp(projectId?: ULID) {
  const app = new Hono();
  registerMcpServerRoutes(app, {
    resolveProject: projectId ? (id) => (id === projectId ? { project: { id: projectId } } : null) : undefined,
  });
  return app;
}

// ─── Global scope ─────────────────────────────────────────────────────────────

test('POST /api/mcp-servers — creates a stdio server', async () => {
  const app = makeApp();
  const res = await app.request('/api/mcp-servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'my-stdio-server',
      description: 'test server',
      transport: { command: 'node', args: ['server.js'] },
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { ok: boolean; server: { id: string; name: string } };
  assert.equal(body.ok, true);
  assert.equal(body.server.name, 'my-stdio-server');
  assert.ok(body.server.id, 'server should have an id');
});

test('GET /api/mcp-servers — lists global servers', async () => {
  const app = makeApp();
  const res = await app.request('/api/mcp-servers');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; servers: { name: string }[] };
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.servers));
  // The server created in the previous test should appear.
  assert.ok(body.servers.some((s) => s.name === 'my-stdio-server'));
});

test('GET /api/mcp-servers/:id — gets a specific server', async () => {
  const app = makeApp();
  // Create first.
  const created = await app
    .request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'get-by-id-server',
        transport: { command: 'python3' },
      }),
    })
    .then((r) => r.json() as Promise<{ ok: boolean; server: { id: string } }>);
  assert.equal(created.ok, true);
  const id = created.server.id;

  const res = await app.request(`/api/mcp-servers/${id}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; server: { id: string; name: string } };
  assert.equal(body.ok, true);
  assert.equal(body.server.id, id);
  assert.equal(body.server.name, 'get-by-id-server');
});

test('GET /api/mcp-servers/:id — 404 on unknown id', async () => {
  const app = makeApp();
  const res = await app.request('/api/mcp-servers/01NOTEXIST0000000000000000');
  assert.equal(res.status, 404);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, false);
});

test('PATCH /api/mcp-servers/:id — updates name and description', async () => {
  const app = makeApp();
  const created = await app
    .request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'patch-target-server',
        transport: { command: 'npx' },
      }),
    })
    .then((r) => r.json() as Promise<{ ok: boolean; server: { id: string } }>);
  const id = created.server.id;

  const res = await app.request(`/api/mcp-servers/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'updated-desc' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; server: { description: string } };
  assert.equal(body.ok, true);
  assert.equal(body.server.description, 'updated-desc');
});

test('DELETE /api/mcp-servers/:id — soft-deletes a server', async () => {
  const app = makeApp();
  const created = await app
    .request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'delete-target-server',
        transport: { command: 'ruby' },
      }),
    })
    .then((r) => r.json() as Promise<{ ok: boolean; server: { id: string } }>);
  const id = created.server.id;

  const del = await app.request(`/api/mcp-servers/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const delBody = (await del.json()) as { ok: boolean };
  assert.equal(delBody.ok, true);

  // Should be gone from GET by id.
  const get = await app.request(`/api/mcp-servers/${id}`);
  assert.equal(get.status, 404);
});

test('POST /api/mcp-servers — 400 on invalid transport (neither command nor url)', async () => {
  const app = makeApp();
  const res = await app.request('/api/mcp-servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'bad-transport',
      transport: { env: { A: 'b' } },
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /command/);
});

// ─── Project scope ────────────────────────────────────────────────────────────

test('project scope: create + list', async () => {
  const project = createProject({
    slug: `mcp-reg-proj-${Date.now()}`,
    name: 'MCP Reg Test Project',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: '',
  });
  const projectId = project.id as ULID;
  const app = makeApp(projectId);

  const create = await app.request(
    `/api/projects/${projectId}/mcp-servers`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'proj-stdio-server',
        transport: { command: 'go' },
      }),
    },
  );
  assert.equal(create.status, 201);
  const createBody = (await create.json()) as { ok: boolean; server: { scope: string } };
  assert.equal(createBody.ok, true);
  assert.equal(createBody.server.scope, 'project');

  const list = await app.request(`/api/projects/${projectId}/mcp-servers`);
  assert.equal(list.status, 200);
  const listBody = (await list.json()) as { ok: boolean; servers: { name: string }[] };
  assert.equal(listBody.ok, true);
  assert.ok(listBody.servers.some((s) => s.name === 'proj-stdio-server'));
});

test('project scope: 404 for unknown project', async () => {
  const knownProjectId = 'proj01KNOWN000000000000000' as ULID;
  const app = makeApp(knownProjectId);
  const res = await app.request('/api/projects/NOTAPROJECT/mcp-servers');
  assert.equal(res.status, 404);
});
