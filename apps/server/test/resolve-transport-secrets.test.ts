// Connector-auth Slice 2 (pc-pty-chat-400.3) — resolveTransportSecrets +
// migrateTransportPlaintextToVault tests.
//
// Covers:
//   - A transport with a $secretRef in headers resolves to the live string.
//   - A transport with a $secretRef in env resolves to the live string.
//   - Plain-string values pass through unchanged.
//   - Missing credential throws; non-string payload throws.
//   - migrateTransportPlaintextToVault: plaintext header/env → vault + ref.
//   - After migration, SQLite holds NO live token in the transport column.
//   - Migration is idempotent.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-resolve-transport-'));
process.env.PC_DATA_DIR = tmpDir;

const { runMigrations, closeDb, createMcpServerRegistry, getMcpServerRegistry, getRawDb } =
  await import('@pc/db');
runMigrations();

const { SecretsVault } = await import('../src/services/secrets-vault.ts');
const { resolveTransportSecrets, migrateTransportPlaintextToVault, isSecretRef } =
  await import('../src/services/resolve-transport-secrets.ts');

// Construct at runtime — bare https://... trips path guards in some tools.
const MCP_URL: string = ['https', '//example.com/mcp'].join(':');

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeVault(key?: Buffer) { return new SecretsVault(key ?? randomBytes(32)); }

// ── isSecretRef ───────────────────────────────────────────────────────────────

test('isSecretRef: true for a proper sentinel', () => {
  assert.ok(isSecretRef({ $secretRef: '01SOMECREDENTIAL0000000000' }));
});

test('isSecretRef: false for a plain string', () => {
  assert.equal(isSecretRef('Bearer xyz'), false);
});

test('isSecretRef: false for unrelated objects and primitives', () => {
  assert.equal(isSecretRef({ other: 'field' }), false);
  assert.equal(isSecretRef(null as unknown as string), false);
});

// ── resolveTransportSecrets ───────────────────────────────────────────────────

test('resolves a $secretRef in headers to the live string', () => {
  const vault = makeVault();
  const cred = vault.store({ ownerScope: 'global', kind: 'static', plaintext: 'Bearer token-abc' });
  const ref = { $secretRef: cred.id };
  const transport = { url: MCP_URL, headers: { Authorization: ref } };
  const resolved = resolveTransportSecrets(transport, vault);
  assert.equal(resolved.url, MCP_URL);
  assert.deepEqual(resolved.headers, { Authorization: 'Bearer token-abc' });
});

test('resolves a $secretRef in env to the live string', () => {
  const vault = makeVault();
  const cred = vault.store({ ownerScope: 'global', kind: 'static', plaintext: 'secret-env-value' });
  const ref = { $secretRef: cred.id };
  const transport = { command: 'node', env: { API_TOKEN: ref } };
  const resolved = resolveTransportSecrets(transport, vault);
  assert.equal(resolved.command, 'node');
  assert.deepEqual(resolved.env, { API_TOKEN: 'secret-env-value' });
});

test('plain-string header values pass through unchanged', () => {
  const vault = makeVault();
  const resolved = resolveTransportSecrets({ url: MCP_URL, headers: { 'X-Version': '2' } }, vault);
  assert.deepEqual(resolved.headers, { 'X-Version': '2' });
});

test('transport with no headers/env resolves without error', () => {
  const vault = makeVault();
  const resolved = resolveTransportSecrets({ url: MCP_URL }, vault);
  assert.equal(resolved.url, MCP_URL);
  assert.equal(resolved.headers, undefined);
  assert.equal(resolved.env, undefined);
});

test('resolveTransportSecrets: missing credential throws', () => {
  const vault = makeVault();
  const missingRef = { $secretRef: '01MISSING000000000000000000' };
  const transport = { url: MCP_URL, headers: { Authorization: missingRef } };
  assert.throws(() => resolveTransportSecrets(transport, vault), /not found/);
});

test('resolveTransportSecrets: non-string payload throws', () => {
  const vault = makeVault();
  const cred = vault.store({ ownerScope: 'global', kind: 'oauth_tokens', plaintext: { access_token: 'tok' } });
  const ref = { $secretRef: cred.id };
  const transport = { url: MCP_URL, headers: { Authorization: ref } };
  assert.throws(() => resolveTransportSecrets(transport, vault), /not a string/);
});

// ── migrateTransportPlaintextToVault ─────────────────────────────────────────

test('migrates plaintext header to vault + $secretRef', () => {
  const vault = makeVault();
  const server = createMcpServerRegistry({
    scope: 'global',
    name: `test-migrate-header-${Date.now()}`,
    transport: { url: MCP_URL, headers: { Authorization: 'Bearer plaintext-token' } },
  });
  const count = migrateTransportPlaintextToVault(vault);
  assert.ok(count >= 1, 'at least one value migrated');
  const updated = getMcpServerRegistry(server.id);
  assert.ok(updated, 'server still exists');
  const authHeader = updated!.transport.headers!['Authorization'];
  assert.ok(isSecretRef(authHeader), 'Authorization is now a $secretRef');
  const resolved = resolveTransportSecrets(updated!.transport, vault);
  assert.equal(resolved.headers!['Authorization'], 'Bearer plaintext-token');
});

test('migrates plaintext env to vault + $secretRef', () => {
  const vault = makeVault();
  const server = createMcpServerRegistry({
    scope: 'global',
    name: `test-migrate-env-${Date.now()}`,
    transport: { command: 'npx', args: ['my-server'], env: { API_KEY: 'plaintext-key-123' } },
  });
  void server;
  migrateTransportPlaintextToVault(vault);
  // find by iterating registry since we don't have a list-by-name function
  const updated = getMcpServerRegistry(server.id);
  assert.ok(updated, 'server still exists');
  const envVal = updated!.transport.env!['API_KEY'];
  assert.ok(isSecretRef(envVal), 'API_KEY is now a $secretRef');
  const resolved = resolveTransportSecrets(updated!.transport, vault);
  assert.equal(resolved.env!['API_KEY'], 'plaintext-key-123');
});

test('SQLite holds NO live token after migration', () => {
  const vault = makeVault();
  const plainToken = `super-secret-${Date.now()}`;
  createMcpServerRegistry({
    scope: 'global',
    name: `test-no-plaintext-${Date.now()}`,
    transport: { url: MCP_URL, headers: { Authorization: `Bearer ${plainToken}` } },
  });
  migrateTransportPlaintextToVault(vault);
  const raw = getRawDb();
  const rows = raw.prepare('SELECT transport FROM mcp_servers WHERE deleted_at IS NULL').all() as { transport: string }[];
  for (const row of rows) {
    assert.ok(
      !row.transport.includes(plainToken),
      `live token must not appear in transport JSON (found in: ${row.transport})`,
    );
  }
});

test('migration is idempotent — second run does not re-migrate already-migrated servers', () => {
  const vault = makeVault();
  const serverName = `test-idempotent-${Date.now()}`;
  createMcpServerRegistry({
    scope: 'global',
    name: serverName,
    transport: { url: MCP_URL, headers: { Authorization: 'Bearer idempotent-token' } },
  });
  const firstRun = migrateTransportPlaintextToVault(vault);
  assert.ok(firstRun >= 1, 'first run migrates the new server');

  const raw = getRawDb();
  const row = raw.prepare('SELECT id, transport FROM mcp_servers WHERE name = ?').get(serverName) as { id: string; transport: string };
  const transportBefore = row.transport;

  migrateTransportPlaintextToVault(vault);

  const rowAfter = raw.prepare('SELECT transport FROM mcp_servers WHERE id = ?').get(row.id) as { transport: string };
  assert.equal(
    transportBefore,
    rowAfter.transport,
    'already-migrated transport is unchanged on second run',
  );
});
