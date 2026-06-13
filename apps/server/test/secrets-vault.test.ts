// Connector-auth Slice 1 (pc-pty-chat-400.2) — SecretsVault unit tests.
//
// Tests the crypto layer (encrypt/decrypt round-trip, tamper detection) and
// the DB-backed store/get/updateAuthState path.
//
// The vault is constructed directly with a test key — no stdin involved.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-vault-'));
process.env.PC_DATA_DIR = tmpDir;

// Boot the DB (runMigrations) before importing the vault service so the
// credentials table exists when vault.store() runs.
const { runMigrations, closeDb, getCredential } = await import('@pc/db');
runMigrations();

const { SecretsVault } = await import('../src/services/secrets-vault.ts');

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeVault(key?: Buffer): SecretsVault {
  return new SecretsVault(key ?? randomBytes(32));
}

// ── Crypto layer ─────────────────────────────────────────────────────────────

test('constructor rejects a key that is not 32 bytes', () => {
  assert.throws(() => new SecretsVault(randomBytes(16)), /32 bytes/);
  assert.throws(() => new SecretsVault(randomBytes(0)), /32 bytes/);
});

test('encrypt → decrypt round-trip (various payloads)', () => {
  const vault = makeVault();

  for (const plaintext of [
    { access_token: 'tok_abc', refresh_token: 'ref_xyz', expires_in: 3600 },
    'a plain string',
    42,
    null,
    [1, 2, { nested: true }],
  ]) {
    const { ciphertext, iv, authTag } = vault.encrypt(plaintext);
    assert.ok(typeof ciphertext === 'string', 'ciphertext is a string');
    assert.ok(typeof iv === 'string', 'iv is a string');
    assert.ok(typeof authTag === 'string', 'authTag is a string');
    const decrypted = vault.decrypt(ciphertext, iv, authTag);
    assert.deepEqual(decrypted, plaintext);
  }
});

test('each encrypt call produces a different IV (nonce uniqueness)', () => {
  const vault = makeVault();
  const payload = { token: 'same' };
  const a = vault.encrypt(payload);
  const b = vault.encrypt(payload);
  assert.notEqual(a.iv, b.iv, 'IVs must differ across calls');
  assert.notEqual(a.ciphertext, b.ciphertext, 'ciphertexts must differ across calls');
});

test('tamper: wrong key → decrypt throws', () => {
  const vault1 = makeVault();
  const vault2 = makeVault(); // different key
  const { ciphertext, iv, authTag } = vault1.encrypt({ secret: 'data' });
  assert.throws(() => vault2.decrypt(ciphertext, iv, authTag));
});

test('tamper: flipped ciphertext bit → decrypt throws', () => {
  const vault = makeVault();
  const { ciphertext, iv, authTag } = vault.encrypt({ secret: 'data' });
  const corrupted = Buffer.from(ciphertext, 'base64');
  corrupted[0] ^= 0xff;
  assert.throws(() => vault.decrypt(corrupted.toString('base64'), iv, authTag));
});

test('tamper: flipped IV → decrypt throws', () => {
  const vault = makeVault();
  const { ciphertext, iv, authTag } = vault.encrypt({ secret: 'data' });
  const corruptedIv = Buffer.from(iv, 'base64');
  corruptedIv[0] ^= 0xff;
  assert.throws(() => vault.decrypt(ciphertext, corruptedIv.toString('base64'), authTag));
});

test('tamper: flipped auth tag → decrypt throws', () => {
  const vault = makeVault();
  const { ciphertext, iv, authTag } = vault.encrypt({ secret: 'data' });
  const corruptedTag = Buffer.from(authTag, 'base64');
  corruptedTag[0] ^= 0xff;
  assert.throws(() => vault.decrypt(ciphertext, iv, corruptedTag.toString('base64')));
});

// ── DB-backed store/get ───────────────────────────────────────────────────────

test('store → get round-trip', () => {
  const vault = makeVault();
  const payload = { access_token: 'tok_store', expires_in: 7200 };

  const row = vault.store({
    ownerScope: 'global',
    kind: 'oauth_tokens',
    plaintext: payload,
  });

  assert.equal(row.authState, 'none');
  assert.equal(row.ownerScope, 'global');
  assert.equal(row.kind, 'oauth_tokens');

  // Ciphertext in DB must NOT be the plaintext.
  const dbRow = getCredential(row.id);
  assert.ok(dbRow);
  assert.notEqual(dbRow!.ciphertext, JSON.stringify(payload));

  const retrieved = vault.get(row.id);
  assert.deepEqual(retrieved, payload);
});

test('get returns null for unknown id', () => {
  const vault = makeVault();
  assert.equal(vault.get('01UNKNOWN000000000000000000'), null);
});

test('store with ownerServerId — getByServer returns the payload', () => {
  const vault = makeVault();
  const serverId = '01TESTSERVER0000000000000C' as const;
  const payload = { static_token: 'Bearer xyz' };

  vault.store({
    ownerScope: 'global',
    ownerServerId: serverId,
    kind: 'static',
    plaintext: payload,
  });

  const retrieved = vault.getByServer(serverId);
  assert.deepEqual(retrieved, payload);
});

test('getByServer returns null for unknown server', () => {
  const vault = makeVault();
  assert.equal(vault.getByServer('01UNKNOWN000000000000000000'), null);
});

// ── authState updates ─────────────────────────────────────────────────────────

test('updateAuthState persists state + lastError and bumps rev', () => {
  const vault = makeVault();
  const row = vault.store({
    ownerScope: 'global',
    kind: 'oauth_tokens',
    plaintext: { token: 'tok' },
  });

  const connected = vault.updateAuthState(row.id, 'connected');
  assert.ok(connected);
  assert.equal(connected!.authState, 'connected');
  assert.equal(connected!.lastError, null);
  assert.equal(connected!.rev, row.rev + 1);

  const failed = vault.updateAuthState(row.id, 'error', 'refresh_failed');
  assert.ok(failed);
  assert.equal(failed!.authState, 'error');
  assert.equal(failed!.lastError, 'refresh_failed');
  assert.equal(failed!.rev, connected!.rev + 1);
});

test('updateAuthState returns null for unknown id', () => {
  const vault = makeVault();
  assert.equal(vault.updateAuthState('01UNKNOWN000000000000000000', 'connected'), null);
});

test('delete removes the credential row', () => {
  const vault = makeVault();
  const row = vault.store({
    ownerScope: 'global',
    kind: 'static',
    plaintext: 'ephemeral',
  });
  assert.ok(vault.get(row.id));

  vault.delete(row.id);
  assert.equal(vault.get(row.id), null);
});

// ── Cross-vault isolation: a value stored by vault-A is unreadable by vault-B ─

test('cross-vault: value stored with key-A cannot be decrypted by vault with key-B', () => {
  const vaultA = makeVault();
  const vaultB = makeVault(); // different key
  const payload = { secret: 'only-A-knows' };

  const row = vaultA.store({ ownerScope: 'global', kind: 'static', plaintext: payload });

  // vaultB.get() should throw because decryption fails (auth tag mismatch).
  assert.throws(() => vaultB.get(row.id));
});
