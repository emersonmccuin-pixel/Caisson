// pc-pty-chat-359 P2 � Discovery probe smoke tests for the MCP server registry.
//
// Tests the probe route + stale-on-transport-edit behaviour. The probe function
// is stubbed so no real subprocesses or network connections are launched.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-mcp-disc-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations } = await import('@pc/db');
const { registerMcpServerRoutes } = await import(
  '../src/features/mcp-servers/routes.ts'
);
const { initVault, SecretsVault } = await import('../src/services/secrets-vault.ts');

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

// Use a scheme-free URL so parseMcpServerTransport accepts it without a
// path-guard rejection. The real probeMcpServer never runs in these tests.
const HTTP_URL = 'mcp.example.com:4321/mcp';

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

test('runAndStoreProbe passes authProvider opts to probe for authType:oauth server', async () => {
  // Set up vault so the route can build a VaultOAuthProvider.
  const key = randomBytes(32);
  initVault(key);
  const vault = new SecretsVault(key);

  // Capture the opts the probe receives.
  let capturedOpts: unknown;
  const capturingProbe = async (
    _config: unknown,
    opts?: unknown,
  ) => {
    capturedOpts = opts;
    return { status: 'ok' as const, tools: ['list_meetings'] };
  };

  const app = new Hono();
  registerMcpServerRoutes(app, { probe: capturingProbe, port: 19998 });

  // Create an OAuth HTTP server.
  const createRes = await app.request('/api/mcp-servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'oauth-probe-opts-test',
      transport: { url: HTTP_URL, authType: 'oauth' },
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as { server: { id: string } };
  const id = created.server.id;

  // Store a token in the vault so the provider has something to supply.
  vault.upsertForServer(id as import('@pc/domain').ULID, 'oauth_tokens', 'global', {
    access_token: 'probe-tok',
    token_type: 'Bearer',
    expires_in: 3600,
  });

  // Trigger probe.
  const res = await app.request('/api/mcp-servers/' + id + '/probe', { method: 'POST' });
  assert.equal(res.status, 200);

  // The probe must have received an authProvider.
  assert.ok(
    capturedOpts !== undefined && (capturedOpts as { authProvider?: unknown }).authProvider !== undefined,
    'probe opts must carry an authProvider for authType:oauth server',
  );
});

test('runAndStoreProbe does NOT pass authProvider for non-oauth server', async () => {
  let capturedOpts: unknown;
  const capturingProbe = async (_config: unknown, opts?: unknown) => {
    capturedOpts = opts;
    return { status: 'ok' as const, tools: ['query'] };
  };

  const app = new Hono();
  registerMcpServerRoutes(app, { probe: capturingProbe });

  const createRes = await app.request('/api/mcp-servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'non-oauth-probe-opts-test',
      transport: { command: 'node', args: ['server.js'] },
    }),
  });
  const created = await createRes.json() as { server: { id: string } };
  const id = created.server.id;

  await app.request('/api/mcp-servers/' + id + '/probe', { method: 'POST' });

  const opts = capturedOpts as { authProvider?: unknown } | undefined;
  assert.ok(
    opts === undefined || opts.authProvider === undefined,
    'non-oauth server probe must not receive an authProvider',
  );
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
