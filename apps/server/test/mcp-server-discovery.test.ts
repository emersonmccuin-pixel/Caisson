// pc-pty-chat-359 P2 � Discovery probe smoke tests for the MCP server registry.
//
// Tests the probe route + stale-on-transport-edit behaviour. The probe function
// is stubbed so no real subprocesses or network connections are launched.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-mcp-disc-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations } = await import('@pc/db');
const { registerMcpServerRoutes } = await import(
  '../src/features/mcp-servers/routes.ts'
);

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Stubs

const successProbe = async () => ({ status: 'ok' as const, tools: ['search', 'fetch'] });
const failProbe = async () => ({ status: 'failed' as const, error: 'connection refused' });
const timeoutProbe = async () => ({ status: 'failed' as const, error: 'probe timed out after 10000ms' });

function makeApp(probe?: typeof successProbe) {
  const app = new Hono();
  registerMcpServerRoutes(app, { probe });
  return app;
}

test('POST .../probe - ok probe stores tools', async () => {
  const app = makeApp(successProbe);

  const create = await app
    .request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'probe-ok-server', transport: { command: 'node', args: ['mcp.js'] } }),
    })
    .then((r) => r.json());
  assert.equal(create.ok, true);
  const id = create.server.id;

  const res = await app.request('/api/mcp-servers/' + id + '/probe', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.server.discoveryStatus, 'ok');
  assert.deepEqual(body.server.discoveredTools, ['search', 'fetch']);
});

test('POST .../probe - failed probe stores failure status', async () => {
  const app = makeApp(failProbe);

  const create = await app
    .request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'probe-fail-server', transport: { command: 'bogus-cmd' } }),
    })
    .then((r) => r.json());
  const id = create.server.id;

  const res = await app.request('/api/mcp-servers/' + id + '/probe', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.server.discoveryStatus, 'failed');
  assert.equal(body.server.discoveredTools, null);
});

test('POST .../probe - timeout probe stores failure', async () => {
  const app = makeApp(timeoutProbe);

  const create = await app
    .request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'probe-timeout-server', transport: { command: 'slow-cmd' } }),
    })
    .then((r) => r.json());
  const id = create.server.id;

  const res = await app.request('/api/mcp-servers/' + id + '/probe', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.server.discoveryStatus, 'failed');
});

test('POST .../probe - 404 on unknown server id', async () => {
  const app = makeApp(successProbe);
  const res = await app.request('/api/mcp-servers/01NOTEXIST0000000000000000/probe', { method: 'POST' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('POST .../probe - 501 when probe not configured', async () => {
  const app = makeApp();

  const create = await app
    .request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'no-probe-server', transport: { command: 'node' } }),
    })
    .then((r) => r.json());
  const id = create.server.id;

  const res = await app.request('/api/mcp-servers/' + id + '/probe', { method: 'POST' });
  assert.equal(res.status, 501);
});

test('PATCH transport resets discoveryStatus to stale and clears tools', async () => {
  const app = makeApp(successProbe);

  const create = await app
    .request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'stale-test-server', transport: { command: 'node', args: ['a.js'] } }),
    })
    .then((r) => r.json());
  const id = create.server.id;

  await app.request('/api/mcp-servers/' + id + '/probe', { method: 'POST' });

  const beforeGetRes = await app.request('/api/mcp-servers/' + id);
  const beforeGet = await beforeGetRes.json();
  assert.equal(beforeGet.server.discoveryStatus, 'ok');
  assert.ok(Array.isArray(beforeGet.server.discoveredTools));

  const patchRes = await app.request('/api/mcp-servers/' + id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transport: { command: 'python3', args: ['b.py'] } }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.ok, true);
  assert.equal(patched.server.discoveryStatus, 'stale');
  assert.equal(patched.server.discoveredTools, null);
});

test('PATCH name/description does NOT reset discovery status', async () => {
  const app = makeApp(successProbe);

  const create = await app
    .request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'meta-patch-server', transport: { command: 'ruby' } }),
    })
    .then((r) => r.json());
  const id = create.server.id;

  await app.request('/api/mcp-servers/' + id + '/probe', { method: 'POST' });

  const patchRes = await app.request('/api/mcp-servers/' + id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'updated description' }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.server.discoveryStatus, 'ok');
  assert.equal(patched.server.description, 'updated description');
});
