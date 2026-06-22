// pc-pty-chat-459 OB — refreshOAuthTokenIfNeeded unit tests.
//
// Tests the core behaviors against a real SQLite DB + vault:
//   1. No-op when no oauth_tokens credential exists.
//   2. No-op when expiresAt is null (server omitted expires_in).
//   3. No-op when token has plenty of life remaining.
//   4. Calls auth() and updates tokens when near-expiry (within 60s).
//   5. Throws cause='oauth-token-expired' when redirect needed (no refresh_token).
//   6. Throws cause='oauth-token-expired' when auth() throws.
//   7. Single-flight: concurrent calls queue behind one refresh.
//
// auth() is mocked via the OAuthRefreshDeps injection seam (same pattern as
// oauth-broker.test.ts) — no real network calls are made.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-oauth-refresh-'));
process.env.PC_DATA_DIR = tmpDir;

const { runMigrations, closeDb, newId, getCredentialByServerAndKind } = await import('@pc/db');
runMigrations();

const { SecretsVault } = await import('../src/services/secrets-vault.ts');
const { VaultOAuthStorage } = await import('../src/services/oauth-provider.ts');
const { refreshOAuthTokenIfNeeded } = await import('../src/services/oauth-refresh.ts');
import type { OAuthRefreshDeps } from '../src/services/oauth-refresh.ts';

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeVault() { return new SecretsVault(randomBytes(32)); }

const MCP_URL = ['https', '//mcp.example.com/api'].join(':');

// ── No-op cases ──────────────────────────────────────────────────────────────

test('refreshOAuthTokenIfNeeded — no-op when no oauth_tokens credential', async () => {
  const vault = makeVault();
  const serverId = newId();
  let authCalled = false;
  const deps: OAuthRefreshDeps = { authFn: async () => { authCalled = true; return 'AUTHORIZED'; } };
  await refreshOAuthTokenIfNeeded(serverId, MCP_URL, 'global', vault, 4040, deps);
  assert.equal(authCalled, false, 'auth should not be called when no credential exists');
});

test('refreshOAuthTokenIfNeeded — no-op when expiresAt is null (server omitted expires_in)', async () => {
  const vault = makeVault();
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');
  // No expires_in → expiresAt stored as null.
  await storage.storeTokens({ access_token: 'tok', token_type: 'Bearer' });

  let authCalled = false;
  const deps: OAuthRefreshDeps = { authFn: async () => { authCalled = true; return 'AUTHORIZED'; } };
  await refreshOAuthTokenIfNeeded(serverId, MCP_URL, 'global', vault, 4040, deps);
  assert.equal(authCalled, false, 'auth should not be called when expiresAt is null');
});

test('refreshOAuthTokenIfNeeded — no-op when token has plenty of life remaining', async () => {
  const vault = makeVault();
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');
  // expires_in = 3600s (1 hour) — well beyond the 60s threshold.
  await storage.storeTokens({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 });

  let authCalled = false;
  const deps: OAuthRefreshDeps = { authFn: async () => { authCalled = true; return 'AUTHORIZED'; } };
  await refreshOAuthTokenIfNeeded(serverId, MCP_URL, 'global', vault, 4040, deps);
  assert.equal(authCalled, false, 'auth should not be called when token is well ahead of expiry');
});

// ── Refresh cases ─────────────────────────────────────────────────────────────

test('refreshOAuthTokenIfNeeded — calls auth() and updates tokens when near expiry', async () => {
  const vault = makeVault();
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');
  // expires_in = 30s — within the 60s REFRESH_THRESHOLD_MS.
  await storage.storeTokens({ access_token: 'old-tok', token_type: 'Bearer', expires_in: 30 });

  let authCalled = false;
  const newTokens = { access_token: 'new-tok', token_type: 'Bearer', expires_in: 3600 };
  const deps: OAuthRefreshDeps = {
    authFn: async (provider) => {
      authCalled = true;
      await provider.saveTokens(newTokens);
      return 'AUTHORIZED';
    },
  };

  await refreshOAuthTokenIfNeeded(serverId, MCP_URL, 'global', vault, 4040, deps);

  assert.equal(authCalled, true, 'auth should be called for near-expiry token');
  const tokens = await storage.loadTokens();
  assert.equal(tokens?.access_token, 'new-tok', 'tokens must be updated after successful refresh');
});

test('refreshOAuthTokenIfNeeded — throws cause=oauth-token-expired when redirect needed', async () => {
  const vault = makeVault();
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');
  await storage.storeTokens({ access_token: 'tok', token_type: 'Bearer', expires_in: 30 });

  const deps: OAuthRefreshDeps = {
    authFn: async (provider) => {
      // Simulate: SDK needs browser auth (no valid refresh_token).
      await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'));
      return 'REDIRECT';
    },
  };

  await assert.rejects(
    () => refreshOAuthTokenIfNeeded(serverId, MCP_URL, 'global', vault, 4040, deps),
    (err: Error & { cause?: unknown }) => {
      assert.equal(err.cause, 'oauth-token-expired', 'error must carry cause=oauth-token-expired');
      return true;
    },
  );

  const credRow = getCredentialByServerAndKind(serverId, 'oauth_tokens');
  assert.ok(credRow, 'credential row must still exist');
  assert.equal(credRow.authState, 'needs-auth', 'authState must be needs-auth after redirect');
});

test('refreshOAuthTokenIfNeeded — throws cause=oauth-token-expired when auth() throws', async () => {
  const vault = makeVault();
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');
  await storage.storeTokens({ access_token: 'tok', token_type: 'Bearer', expires_in: 30 });

  const deps: OAuthRefreshDeps = {
    authFn: async () => { throw new Error('token_endpoint unreachable'); },
  };

  await assert.rejects(
    () => refreshOAuthTokenIfNeeded(serverId, MCP_URL, 'global', vault, 4040, deps),
    (err: Error & { cause?: unknown }) => {
      assert.equal(err.cause, 'oauth-token-expired');
      assert.match(err.message, /token_endpoint unreachable/);
      return true;
    },
  );

  const credRow = getCredentialByServerAndKind(serverId, 'oauth_tokens');
  assert.equal(credRow?.authState, 'needs-auth');
});

// ── Single-flight ─────────────────────────────────────────────────────────────

test('refreshOAuthTokenIfNeeded — single-flight: concurrent calls queue behind one refresh', async () => {
  const vault = makeVault();
  const serverId = newId();
  const storage = new VaultOAuthStorage(vault, serverId, 'global');
  await storage.storeTokens({ access_token: 'tok', token_type: 'Bearer', expires_in: 30 });

  let authCallCount = 0;
  let resolveBarrier!: () => void;
  const barrier = new Promise<void>((res) => { resolveBarrier = res; });

  const deps: OAuthRefreshDeps = {
    authFn: async (provider) => {
      authCallCount++;
      await barrier;
      await provider.saveTokens({ access_token: 'refreshed', token_type: 'Bearer', expires_in: 3600 });
      return 'AUTHORIZED';
    },
  };

  // Fire two concurrent refreshes for the same server.
  const p1 = refreshOAuthTokenIfNeeded(serverId, MCP_URL, 'global', vault, 4040, deps);
  const p2 = refreshOAuthTokenIfNeeded(serverId, MCP_URL, 'global', vault, 4040, deps);

  resolveBarrier();
  await Promise.all([p1, p2]);

  assert.equal(authCallCount, 1, 'auth must be called only once despite two concurrent callers');
  const tokens = await storage.loadTokens();
  assert.equal(tokens?.access_token, 'refreshed');
});
