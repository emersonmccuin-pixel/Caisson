// Connector-auth Slice 4 (pc-pty-chat-400.5) — OAuth broker integration tests.
//
// Tests the two broker routes against a mock auth() function so no real network
// calls are made. Covers:
//   1. start → REDIRECT → callback with matching state → tokens stored, authState 'connected'
//   2. callback with mismatched state → rejected (CSRF guard)
//   3. callback with OAuth error param → error page
//   4. start on stdio server → 400 (no URL transport)
//   5. start returns 'authorized' when tokens already present

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-oauth-broker-'));
process.env.PC_DATA_DIR = tmpDir;

// Boot DB + vault before importing route modules.
const { runMigrations, closeDb, createMcpServerRegistry, getCredentialByServerAndKind } = await import('@pc/db');
runMigrations();

const { initVault, getSecretsVault } = await import('../src/services/secrets-vault.ts');
initVault(randomBytes(32));

const { registerMcpServerRoutes } = await import('../src/features/mcp-servers/routes.ts');
import type { AuthFn } from '../src/features/mcp-servers/oauth-routes.ts';
import type { VaultOAuthProvider } from '../src/services/oauth-provider.ts';

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Shared state for the mock auth flow ───────────────────────────────────────

/** The OAuth state value the mock embeds in the authorization URL. */
const TEST_STATE = `test_state_${Date.now()}`;
const TEST_AUTH_URL = `https://auth.example.com/authorize?response_type=code&client_id=c1&state=${TEST_STATE}`;
const TEST_CODE = 'auth_code_xyz';
const TEST_TOKENS = { access_token: 'access_tok_abc', token_type: 'Bearer', expires_in: 3600 };

/**
 * Mock authFn that drives the OAuth flow without network calls:
 * - Without authorizationCode: saves verifier, calls redirectToAuthorization, returns REDIRECT.
 * - With authorizationCode: saves tokens, returns AUTHORIZED.
 */
const mockAuthFn: AuthFn = async (
  provider: VaultOAuthProvider,
  options: { serverUrl: string | URL; authorizationCode?: string },
) => {
  if (options.authorizationCode) {
    await provider.saveTokens(TEST_TOKENS);
    return 'AUTHORIZED';
  }
  // Simulate PKCE + redirect.
  await provider.saveCodeVerifier('pkce_verifier_abc');
  await provider.redirectToAuthorization(new URL(TEST_AUTH_URL));
  return 'REDIRECT';
};

/** authFn that signals tokens are already present (returns AUTHORIZED immediately). */
const alreadyAuthorizedFn: AuthFn = async () => 'AUTHORIZED';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeApp(authFn?: AuthFn): { app: Hono; serverId: ULID } {
  const app = new Hono();
  // Create a fresh HTTP server entry for this test.
  const server = createMcpServerRegistry({
    scope: 'global',
    projectId: null,
    name: `oauth-test-server-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    description: '',
    transport: { url: 'https://mcp.example.com/mcp' },
  });
  registerMcpServerRoutes(app, {
    port: 19999,
    oauthAuthFn: authFn,
  });
  return { app, serverId: server.id };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('auth/start → REDIRECT, callback matching state → tokens stored + authState connected', async () => {
  const { app, serverId } = makeApp(mockAuthFn);

  // Step 1: start the flow.
  const startRes = await app.request(`/api/mcp-servers/${serverId}/auth/start`, {
    method: 'POST',
  });
  assert.equal(startRes.status, 200);
  const startBody = (await startRes.json()) as { ok: boolean; status: string; authorizationUrl?: string };
  assert.equal(startBody.ok, true);
  assert.equal(startBody.status, 'redirect');
  assert.ok(startBody.authorizationUrl, 'must include authorizationUrl');
  assert.ok(startBody.authorizationUrl?.includes(TEST_STATE), 'authorizationUrl must contain the state');

  // Step 2: simulate browser callback with the matching state.
  const callbackRes = await app.request(
    `/api/oauth/callback?code=${TEST_CODE}&state=${TEST_STATE}`,
  );
  assert.equal(callbackRes.status, 200);
  const html = await callbackRes.text();
  assert.ok(html.includes('Authentication complete'), 'success page must mention Authentication complete');

  // Step 3: verify tokens are in the vault.
  const vault = getSecretsVault();
  const credRow = getCredentialByServerAndKind(serverId, 'oauth_tokens');
  assert.ok(credRow, 'a credentials row must exist after auth');
  const tokens = vault.getByServerAndKind(serverId, 'oauth_tokens') as typeof TEST_TOKENS | null;
  assert.ok(tokens, 'tokens must be stored in the vault');
  assert.equal(tokens.access_token, TEST_TOKENS.access_token);

  // Step 4: verify authState is 'connected'.
  const refreshed = getCredentialByServerAndKind(serverId, 'oauth_tokens');
  assert.equal(refreshed?.authState, 'connected', 'authState must be connected after callback');
});

test('callback with mismatched state → rejected (CSRF guard)', async () => {
  const { app } = makeApp(mockAuthFn);

  const res = await app.request(
    '/api/oauth/callback?code=some_code&state=WRONG_STATE_NOT_REGISTERED',
  );
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.ok(html.includes('State mismatch'), 'error page must mention State mismatch');
});

test('callback with OAuth error param → error page returned', async () => {
  const { app } = makeApp(mockAuthFn);

  const res = await app.request('/api/oauth/callback?error=access_denied');
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.ok(html.includes('access_denied'), 'error page must surface the OAuth error');
});

test('auth/start on stdio server → 400 (no URL transport)', async () => {
  const app = new Hono();
  const stdioServer = createMcpServerRegistry({
    scope: 'global',
    projectId: null,
    name: `oauth-stdio-test-${Date.now()}`,
    description: '',
    transport: { command: 'node', args: ['server.js'] },
  });
  registerMcpServerRoutes(app, { port: 19999, oauthAuthFn: mockAuthFn });

  const res = await app.request(`/api/mcp-servers/${stdioServer.id}/auth/start`, {
    method: 'POST',
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /HTTP transport/);
});

test('auth/start returns authorized when tokens already present', async () => {
  const { app, serverId } = makeApp(alreadyAuthorizedFn);

  const res = await app.request(`/api/mcp-servers/${serverId}/auth/start`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; status: string };
  assert.equal(body.ok, true);
  assert.equal(body.status, 'authorized');
});

test('auth/start → 404 for unknown server id', async () => {
  const { app } = makeApp(mockAuthFn);
  const res = await app.request('/api/mcp-servers/01NOTEXIST0000000000000000/auth/start', {
    method: 'POST',
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, false);
});
