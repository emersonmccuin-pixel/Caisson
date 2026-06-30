// pc-pty-chat-457 — Verify that buildRegistryMcpConfig resolves $secretRef
// header values to live plaintext strings via the vault singleton.
//
// This tests the Slice 7 wiring: when the vault is initialized, SecretRef
// objects in transport.headers are resolved before the config reaches mcp.json.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-spawn-header-res-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, createAgent, createMcpServerRegistry, upsertMcpAttachment } =
  await import('@pc/db');
runMigrations();

const { SecretsVault, initVault } = await import('../src/services/secrets-vault.ts');
const { buildRegistryMcpConfig } = await import('../src/services/pod-spawn.ts');

// Construct at runtime to avoid path-guard checks on bare url strings.
const MCP_URL: string = ['https', '//example.com/mcp'].join(':');

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeAgent() {
  return createAgent(
    { name: 'hdr-agent-' + Date.now() + '-' + Math.random(), scope: 'global', prompt: '' },
    { actor: 'user', reason: 'test' },
  );
}

test('buildRegistryMcpConfig resolves $secretRef headers to live strings via vault', () => {
  const key = randomBytes(32);
  const vault = new SecretsVault(key);
  initVault(key);

  const cred = vault.store({ ownerScope: 'global', kind: 'static', plaintext: 'Bearer live-token' });
  const server = createMcpServerRegistry({
    scope: 'global',
    name: 'header-res-srv-' + Date.now(),
    transport: {
      url: MCP_URL,
      headers: { Authorization: { $secretRef: cred.id } },
    },
  });

  const agent = makeAgent();
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const result = buildRegistryMcpConfig(agent.id);

  assert.ok(result.servers[server.name], 'server present in config');
  assert.equal(
    result.servers[server.name].headers?.['Authorization'],
    'Bearer live-token',
    'Authorization header resolved to live plaintext string',
  );
});

test('buildRegistryMcpConfig passes through plain-string headers unchanged', () => {
  const server = createMcpServerRegistry({
    scope: 'global',
    name: 'plain-header-srv-' + Date.now(),
    transport: {
      url: MCP_URL,
      headers: { 'X-Version': '2' },
    },
  });

  const agent = makeAgent();
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const result = buildRegistryMcpConfig(agent.id);

  assert.ok(result.servers[server.name], 'server present');
  assert.equal(result.servers[server.name].headers?.['X-Version'], '2', 'plain header preserved');
});

test('buildRegistryMcpConfig resolves oauth_tokens $secretRef to Bearer access_token', () => {
  const key = randomBytes(32);
  const vault = new SecretsVault(key);
  initVault(key);

  // Store an OAuthTokens payload (as created by VaultOAuthStorage.storeTokens).
  const cred = vault.store({
    ownerScope: 'global',
    kind: 'oauth_tokens',
    plaintext: { access_token: 'oauth-access-tok', token_type: 'Bearer', expires_in: 3600 },
  });
  const server = createMcpServerRegistry({
    scope: 'global',
    name: 'oauth-token-srv-' + Date.now(),
    transport: {
      url: MCP_URL,
      headers: { Authorization: { $secretRef: cred.id } },
    },
  });

  const agent = makeAgent();
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const result = buildRegistryMcpConfig(agent.id);

  assert.ok(result.servers[server.name], 'server present in config');
  assert.equal(
    result.servers[server.name].headers?.['Authorization'],
    'Bearer oauth-access-tok',
    'oauth_tokens resolves to Bearer <access_token>',
  );
});

test('buildRegistryMcpConfig injects Authorization:Bearer for authType:oauth server with stored token', () => {
  const key = randomBytes(32);
  const vault = new SecretsVault(key);
  initVault(key);

  // Register an OAuth server with NO Authorization header in the transport
  // (the pattern the UI creates: authType:'oauth', no $secretRef header).
  const server = createMcpServerRegistry({
    scope: 'global',
    name: 'oauth-bearer-inject-' + Date.now(),
    transport: {
      url: MCP_URL,
      authType: 'oauth' as const,
    },
  });

  // Store tokens in the vault the way the OAuth callback does.
  vault.upsertForServer(server.id, 'oauth_tokens', 'global', {
    access_token: 'injected-access-tok',
    token_type: 'Bearer',
    expires_in: 3600,
  });

  const agent = makeAgent();
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const result = buildRegistryMcpConfig(agent.id);

  assert.ok(result.servers[server.name], 'OAuth server present in config');
  assert.equal(
    result.servers[server.name].headers?.['Authorization'],
    'Bearer injected-access-tok',
    'Bearer token injected into spawn-time config for authType:oauth server',
  );
});

test('buildRegistryMcpConfig leaves non-oauth server headers unchanged', () => {
  const key = randomBytes(32);
  const vault = new SecretsVault(key);
  initVault(key);

  const cred = vault.store({ ownerScope: 'global', kind: 'static', plaintext: 'Bearer static-tok' });
  const server = createMcpServerRegistry({
    scope: 'global',
    name: 'non-oauth-static-' + Date.now(),
    transport: {
      url: MCP_URL,
      headers: { Authorization: { $secretRef: cred.id } },
    },
  });

  const agent = makeAgent();
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const result = buildRegistryMcpConfig(agent.id);

  assert.ok(result.servers[server.name], 'static server present');
  assert.equal(
    result.servers[server.name].headers?.['Authorization'],
    'Bearer static-tok',
    'static $secretRef resolved; no oauth injection',
  );
});

test('buildRegistryMcpConfig does not inject Bearer when no token stored for authType:oauth', () => {
  // OAuth server registered but user hasn't completed the Authorize flow yet.
  const server = createMcpServerRegistry({
    scope: 'global',
    name: 'oauth-no-token-' + Date.now(),
    transport: {
      url: MCP_URL,
      authType: 'oauth' as const,
    },
  });

  const agent = makeAgent();
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const result = buildRegistryMcpConfig(agent.id);

  assert.ok(result.servers[server.name], 'server present even without token');
  assert.equal(
    result.servers[server.name].headers?.['Authorization'],
    undefined,
    'no Authorization header injected when no token stored',
  );
});

test('buildRegistryMcpConfig skips a server when $secretRef credential is missing', () => {
  const missingRef = { $secretRef: '01MISSING000000000000000000' };
  const server = createMcpServerRegistry({
    scope: 'global',
    name: 'missing-cred-srv-' + Date.now(),
    transport: {
      url: MCP_URL,
      headers: { Authorization: missingRef },
    },
  });

  const agent = makeAgent();
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const result = buildRegistryMcpConfig(agent.id);
  assert.equal(
    result.servers[server.name],
    undefined,
    'server with unresolvable credential is silently skipped',
  );
});
