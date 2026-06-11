// Connector-auth Slice 3 (pc-pty-chat-400.4) — VaultOAuthStorage integration tests.
//
// Tests that VaultOAuthStorage correctly persists OAuth state through the vault.
// Uses a real SQLite DB (runMigrations) and a test SecretsVault.
// The createOAuthProvider factory is smoke-tested for correct wiring.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-oauth-prov-'));
process.env.PC_DATA_DIR = tmpDir;

const { runMigrations, closeDb, newId } = await import('@pc/db');
runMigrations();

const { SecretsVault } = await import('../src/services/secrets-vault.ts');
const { VaultOAuthStorage, createOAuthProvider } = await import('../src/services/oauth-provider.ts');

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── VaultOAuthStorage ─────────────────────────────────────────────────────────

test('VaultOAuthStorage — tokens round-trip through vault', async () => {
  const vault = new SecretsVault(randomBytes(32));
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');

  assert.equal(await storage.loadTokens(), undefined, 'no tokens initially');

  const tokens = { access_token: 'vault_tok', token_type: 'Bearer', expires_in: 3600 };
  await storage.storeTokens(tokens);

  const loaded = await storage.loadTokens();
  assert.ok(loaded, 'tokens should be loaded after storing');
  assert.equal(loaded.access_token, 'vault_tok');
  assert.equal(loaded.token_type, 'Bearer');
  assert.equal(loaded.expires_in, 3600);
});

test('VaultOAuthStorage — client information round-trip', async () => {
  const vault = new SecretsVault(randomBytes(32));
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');

  assert.equal(await storage.loadClientInformation(), undefined, 'no client info initially');

  const clientInfo = {
    client_id: 'dcr_client',
    client_secret: 'dcr_secret',
    redirect_uris: [] as string[],
  };
  await storage.storeClientInformation(clientInfo);

  const loaded = await storage.loadClientInformation();
  assert.ok(loaded, 'client info should be loaded after storing');
  assert.equal(loaded.client_id, 'dcr_client');
});

test('VaultOAuthStorage — storeTokens upserts (second write overwrites first)', async () => {
  const vault = new SecretsVault(randomBytes(32));
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');

  await storage.storeTokens({ access_token: 'old', token_type: 'Bearer' });
  await storage.storeTokens({ access_token: 'new', token_type: 'Bearer', refresh_token: 'ref' });

  const loaded = await storage.loadTokens();
  assert.equal(loaded?.access_token, 'new', 'second storeTokens must overwrite first');
  assert.equal(loaded?.refresh_token, 'ref');
});

test('VaultOAuthStorage — client info upserts (second write overwrites first)', async () => {
  const vault = new SecretsVault(randomBytes(32));
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');

  await storage.storeClientInformation({ client_id: 'old_client', redirect_uris: [] as string[] });
  await storage.storeClientInformation({ client_id: 'new_client', redirect_uris: [] as string[] });

  const loaded = await storage.loadClientInformation();
  assert.equal(loaded?.client_id, 'new_client');
});

test('VaultOAuthStorage — code verifier is in-memory (not persisted to vault)', async () => {
  const vault = new SecretsVault(randomBytes(32));
  const serverId = newId();
  const storage1 = new VaultOAuthStorage(vault, serverId, 'global');

  await storage1.storeCodeVerifier('verifier_xyz');
  assert.equal(await storage1.loadCodeVerifier(), 'verifier_xyz', 'same instance: verifier readable');

  // A new storage instance for the same server cannot see the in-memory verifier
  const storage2 = new VaultOAuthStorage(vault, serverId, 'global');
  await assert.rejects(
    () => storage2.loadCodeVerifier(),
    /No code verifier/,
    'new instance: verifier not accessible (in-memory only)',
  );
});

test('VaultOAuthStorage — discovery state is in-memory (not persisted to vault)', async () => {
  const vault = new SecretsVault(randomBytes(32));
  const serverId = newId();
  const storage1 = new VaultOAuthStorage(vault, serverId, 'global');

  const ds = { authorizationServerUrl: 'http://auth.test' };
  await storage1.storeDiscoveryState(ds);
  assert.deepEqual(await storage1.loadDiscoveryState(), ds);

  const storage2 = new VaultOAuthStorage(vault, serverId, 'global');
  assert.equal(await storage2.loadDiscoveryState(), undefined, 'new instance: no cached discovery state');
});

test('VaultOAuthStorage — invalidate("tokens") removes tokens but keeps client info', async () => {
  const vault = new SecretsVault(randomBytes(32));
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');

  await storage.storeTokens({ access_token: 'to_delete', token_type: 'Bearer' });
  await storage.storeClientInformation({ client_id: 'keep_me', redirect_uris: [] as string[] });

  await storage.invalidate('tokens');

  assert.equal(await storage.loadTokens(), undefined, 'tokens cleared');
  const info = await storage.loadClientInformation();
  assert.equal(info?.client_id, 'keep_me', 'client info survives invalidate("tokens")');
});

test('VaultOAuthStorage — invalidate("client") removes client info but keeps tokens', async () => {
  const vault = new SecretsVault(randomBytes(32));
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');

  await storage.storeTokens({ access_token: 'keep_tok', token_type: 'Bearer' });
  await storage.storeClientInformation({ client_id: 'to_delete', redirect_uris: [] as string[] });

  await storage.invalidate('client');

  assert.equal(await storage.loadClientInformation(), undefined, 'client info cleared');
  const tokens = await storage.loadTokens();
  assert.equal(tokens?.access_token, 'keep_tok', 'tokens survive invalidate("client")');
});

test('VaultOAuthStorage — invalidate("all") removes all vault-backed state', async () => {
  const vault = new SecretsVault(randomBytes(32));
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');

  await storage.storeTokens({ access_token: 'tok', token_type: 'Bearer' });
  await storage.storeClientInformation({ client_id: 'cid', redirect_uris: [] as string[] });
  await storage.storeCodeVerifier('verifier');
  await storage.storeDiscoveryState({ authorizationServerUrl: 'http://auth.test' });

  await storage.invalidate('all');

  assert.equal(await storage.loadTokens(), undefined);
  assert.equal(await storage.loadClientInformation(), undefined);
  await assert.rejects(() => storage.loadCodeVerifier(), /No code verifier/);
  assert.equal(await storage.loadDiscoveryState(), undefined);
});

// ── createOAuthProvider factory ───────────────────────────────────────────────

test('createOAuthProvider — builds provider with correct redirect URL and default client metadata', () => {
  const vault = new SecretsVault(randomBytes(32));
  const serverId = newId();
  const urls: string[] = [];

  const provider = createOAuthProvider({
    serverId,
    ownerScope: 'global',
    redirectPort: 4040,
    onRedirectToAuthorization: (url) => { urls.push(url.toString()); },
    vault,
  });

  const expected = 'http://127.0.0.1:4040/api/oauth/callback';
  assert.equal(provider.redirectUrl, expected, 'redirect URL must be the loopback callback');
  assert.ok(
    provider.clientMetadata.redirect_uris.includes(expected),
    'clientMetadata.redirect_uris must include the redirect URL',
  );
  assert.equal(provider.clientMetadata.client_name, 'Caisson');
});

test('createOAuthProvider — clientMetadata overrides are merged', () => {
  const vault = new SecretsVault(randomBytes(32));
  const serverId = newId();

  const provider = createOAuthProvider({
    serverId,
    ownerScope: 'project',
    redirectPort: 9090,
    clientMetadata: { client_name: 'Custom App', scope: 'read write' },
    onRedirectToAuthorization: () => {},
    vault,
  });

  assert.equal(provider.clientMetadata.client_name, 'Custom App', 'custom client_name overrides default');
  assert.equal(provider.clientMetadata.scope, 'read write');
  // redirect_uris should still contain the loopback URL
  assert.ok(
    provider.clientMetadata.redirect_uris.some((u) => u.includes('9090')),
    'redirect_uris must still include the resolved loopback URL',
  );
});
