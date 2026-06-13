// Connector-auth Slice 1 (pc-pty-chat-400.2) — credentials table migration,
// CRUD, and authState update.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-credentials-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  assertSchemaIntact,
  closeDb,
  createCredential,
  deleteCredential,
  getCredential,
  getCredentialByServer,
  getRawDb,
  listCredentialsByScope,
  runMigrations,
  updateCredentialAuthState,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const FAKE_SERVER_ID = '01TESTSERVER0000000000000A' as const;
const FAKE_SERVER_ID2 = '01TESTSERVER0000000000000B' as const;

test('0058 creates credentials table with every schema.ts column', () => {
  const raw = getRawDb();
  const cols = (raw.pragma('table_info("credentials")') as { name: string }[]).map((c) => c.name);
  for (const col of [
    'id',
    'owner_scope',
    'owner_server_id',
    'kind',
    'ciphertext',
    'iv',
    'auth_tag',
    'auth_state',
    'last_error',
    'expires_at',
    'rev',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(cols.includes(col), `credentials.${col} should exist`);
  }
});

test('assertSchemaIntact does not throw after migration', () => {
  assert.doesNotThrow(() => assertSchemaIntact());
});

test('create stores a row; get returns it', () => {
  const cred = createCredential({
    ownerScope: 'global',
    ownerServerId: FAKE_SERVER_ID,
    kind: 'oauth_tokens',
    ciphertext: 'Y2lwaGVydGV4dA==',
    iv: 'aXY=',
    authTag: 'dGFn',
  });

  assert.equal(cred.ownerScope, 'global');
  assert.equal(cred.ownerServerId, FAKE_SERVER_ID);
  assert.equal(cred.kind, 'oauth_tokens');
  assert.equal(cred.authState, 'none');
  assert.equal(cred.lastError, null);
  assert.equal(cred.expiresAt, null);
  assert.equal(cred.rev, 1);

  const fetched = getCredential(cred.id);
  assert.ok(fetched);
  assert.equal(fetched!.id, cred.id);
  assert.equal(fetched!.ciphertext, 'Y2lwaGVydGV4dA==');
});

test('getCredentialByServer finds by ownerServerId', () => {
  const cred = createCredential({
    ownerScope: 'global',
    ownerServerId: FAKE_SERVER_ID2,
    kind: 'static',
    ciphertext: 'abc',
    iv: 'def',
    authTag: 'ghi',
  });

  const found = getCredentialByServer(FAKE_SERVER_ID2);
  assert.ok(found);
  assert.equal(found!.id, cred.id);
});

test('getCredentialByServer returns null for unknown server', () => {
  assert.equal(getCredentialByServer('01UNKNOWN000000000000000000'), null);
});

test('listCredentialsByScope filters correctly', () => {
  const g = createCredential({
    ownerScope: 'global',
    kind: 'provider_tokens',
    ciphertext: 'x',
    iv: 'y',
    authTag: 'z',
  });
  const p = createCredential({
    ownerScope: 'project',
    kind: 'static',
    ciphertext: 'a',
    iv: 'b',
    authTag: 'c',
  });

  const globals = listCredentialsByScope('global');
  const projects = listCredentialsByScope('project');

  assert.ok(globals.some((r) => r.id === g.id));
  assert.ok(!globals.some((r) => r.id === p.id));
  assert.ok(projects.some((r) => r.id === p.id));
  assert.ok(!projects.some((r) => r.id === g.id));
});

test('updateCredentialAuthState bumps rev and persists state + error', () => {
  const cred = createCredential({
    ownerScope: 'global',
    kind: 'oauth_tokens',
    ciphertext: 'cipher',
    iv: 'iv',
    authTag: 'tag',
  });

  const updated = updateCredentialAuthState(cred.id, 'connected', null);
  assert.ok(updated);
  assert.equal(updated!.authState, 'connected');
  assert.equal(updated!.lastError, null);
  assert.equal(updated!.rev, cred.rev + 1);

  const withError = updateCredentialAuthState(cred.id, 'error', 'token_expired');
  assert.ok(withError);
  assert.equal(withError!.authState, 'error');
  assert.equal(withError!.lastError, 'token_expired');
  assert.equal(withError!.rev, updated!.rev + 1);
});

test('updateCredentialAuthState returns null for unknown id', () => {
  const result = updateCredentialAuthState('01UNKNOWN000000000000000000', 'connected', null);
  assert.equal(result, null);
});

test('deleteCredential removes the row', () => {
  const cred = createCredential({
    ownerScope: 'global',
    kind: 'static',
    ciphertext: 'c',
    iv: 'i',
    authTag: 't',
  });
  assert.ok(getCredential(cred.id));

  deleteCredential(cred.id);
  assert.equal(getCredential(cred.id), null);
});

test('getCredential returns null for unknown id', () => {
  assert.equal(getCredential('01UNKNOWN000000000000000000'), null);
});
