// OC (pc-pty-chat-460) -- authState surface on MCP server GET routes.
//
// Verifies the route layer joins the linked oauth_tokens credential row
// and surfaces authState on every GET response.
//
// Note: parseMcpServerTransport only requires url to be a non-empty string,
// so test fixtures use a scheme-free URL string to avoid sandbox path checks.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-mcp-oauth-authstate-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  runMigrations,
  closeDb,
  createMcpServerRegistry,
  createCredential,
  updateCredentialAuthState,
} = await import('@pc/db');
runMigrations();

const { registerMcpServerRoutes } = await import('../src/features/mcp-servers/routes.ts');

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp() {
  const app = new Hono();
  registerMcpServerRoutes(app, {});
  return app;
}

// parseMcpServerTransport only checks url is a non-empty string — no scheme required.
const TEST_URL = 'mcp.local:9999/mcp';

// Stub crypto fields for credential rows (route reads only authState, never decrypts).
function fakeCrypto() {
  return {
    ciphertext: Buffer.from('test').toString('base64'),
    iv: Buffer.from('testtesttest').toString('base64'),
    authTag: Buffer.from('testtagtestttag!').toString('base64'),
  };
}

// 1. No credential -> authState null

test('GET /api/mcp-servers/:id returns authState:null when no credential', async () => {
  const app = makeApp();
  const server = createMcpServerRegistry({
    scope: 'global',
    name: `authstate-nocred-${Date.now()}`,
    description: '',
    transport: { url: TEST_URL, authType: 'oauth' },
  });

  const res = await app.request(`/api/mcp-servers/${server.id}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; server: { authState: unknown } };
  assert.equal(body.ok, true);
  assert.equal(body.server.authState, null);
});

// 2. With credential -> authState reflects credential row

test('GET /api/mcp-servers/:id returns authState from linked credential', async () => {
  const app = makeApp();
  const server = createMcpServerRegistry({
    scope: 'global',
    name: `authstate-cred-${Date.now()}`,
    description: '',
    transport: { url: TEST_URL, authType: 'oauth' },
  });

  createCredential({
    ownerScope: 'global',
    ownerServerId: server.id,
    kind: 'oauth_tokens',
    ...fakeCrypto(),
    authState: 'connected',
  });

  const res = await app.request(`/api/mcp-servers/${server.id}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; server: { authState: string } };
  assert.equal(body.ok, true);
  assert.equal(body.server.authState, 'connected');
});

// 3. List route includes authState per server

test('GET /api/mcp-servers list includes authState per server', async () => {
  const app = makeApp();
  const serverA = createMcpServerRegistry({
    scope: 'global',
    name: `authstate-list-a-${Date.now()}`,
    description: '',
    transport: { url: TEST_URL, authType: 'oauth' },
  });
  const serverB = createMcpServerRegistry({
    scope: 'global',
    name: `authstate-list-b-${Date.now()}`,
    description: '',
    transport: { url: TEST_URL, authType: 'oauth' },
  });

  // serverA gets a credential; serverB has none -> authState: null.
  createCredential({
    ownerScope: 'global',
    ownerServerId: serverA.id,
    kind: 'oauth_tokens',
    ...fakeCrypto(),
    authState: 'needs-auth',
  });

  const res = await app.request('/api/mcp-servers');
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    servers: { id: string; authState: unknown }[];
  };
  assert.equal(body.ok, true);
  const a = body.servers.find((s) => s.id === serverA.id);
  const b = body.servers.find((s) => s.id === serverB.id);
  assert.ok(a, 'serverA must appear in list');
  assert.ok(b, 'serverB must appear in list');
  assert.equal(a!.authState, 'needs-auth');
  assert.equal(b!.authState, null);
});

// 4. authType round-trips through POST + GET

test('POST + GET /api/mcp-servers -- authType oauth round-trips', async () => {
  const app = makeApp();
  const createRes = await app.request('/api/mcp-servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `oauth-transport-rt-${Date.now()}`,
      transport: { url: TEST_URL, authType: 'oauth' },
    }),
  });
  assert.equal(createRes.status, 201);
  const created = (await createRes.json()) as {
    ok: boolean;
    server: { id: string; transport: { authType?: string } };
  };
  assert.equal(created.ok, true);
  assert.equal(created.server.transport.authType, 'oauth');

  const getRes = await app.request(`/api/mcp-servers/${created.server.id}`);
  assert.equal(getRes.status, 200);
  const got = (await getRes.json()) as {
    ok: boolean;
    server: { transport: { authType?: string } };
  };
  assert.equal(got.server.transport.authType, 'oauth');
});

// 5. parseMcpServerTransport rejects authType on stdio server

test('POST /api/mcp-servers -- 400 when authType set on stdio server', async () => {
  const app = makeApp();
  const res = await app.request('/api/mcp-servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `bad-oauth-stdio-${Date.now()}`,
      transport: { command: 'node', authType: 'oauth' },
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /authType/);
});

// 6. authState reflects credential update

test('GET /api/mcp-servers/:id reflects credential authState update', async () => {
  const app = makeApp();
  const server = createMcpServerRegistry({
    scope: 'global',
    name: `authstate-update-${Date.now()}`,
    description: '',
    transport: { url: TEST_URL, authType: 'oauth' },
  });

  const cred = createCredential({
    ownerScope: 'global',
    ownerServerId: server.id,
    kind: 'oauth_tokens',
    ...fakeCrypto(),
    authState: 'needs-auth',
  });

  const res1 = await app.request(`/api/mcp-servers/${server.id}`);
  const body1 = (await res1.json()) as { ok: boolean; server: { authState: string } };
  assert.equal(body1.server.authState, 'needs-auth');

  updateCredentialAuthState(cred.id, 'expired', null);

  const res2 = await app.request(`/api/mcp-servers/${server.id}`);
  const body2 = (await res2.json()) as { ok: boolean; server: { authState: string } };
  assert.equal(body2.server.authState, 'expired');
});
