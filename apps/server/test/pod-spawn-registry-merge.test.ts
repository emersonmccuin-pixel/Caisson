// pc-pty-chat-359 P4a — Tests for buildRegistryMcpConfig (spawn-resolve merge)
// and wildcard catalog generalization.
//
// Verifies that agent MCP registry attachments are correctly resolved into the
// `servers` + `catalog` maps that preparePodSpawn merges into the mcp.json
// and mcpToolCatalog respectively.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-spawn-reg-merge-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createAgent,
  createMcpServerRegistry,
  getMcpServerRegistry,
  setMcpServerDiscovery,
  upsertMcpAttachment,
} = await import('@pc/db');
const { buildRegistryMcpConfig } = await import('../src/services/pod-spawn.ts');
const { expandToolWildcards } = await import('@pc/runtime');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgent() {
  return createAgent(
    { name: 'test-agent-' + Date.now() + '-' + Math.random(), scope: 'global', prompt: '' },
    { actor: 'user', reason: 'test' },
  );
}

function makeRegistryServer(discoveredTools: string[] | null = null) {
  const server = createMcpServerRegistry({
    scope: 'global',
    name: 'reg-srv-' + Date.now() + '-' + Math.random(),
    transport: { command: 'node', args: ['server.js'] },
  });
  if (discoveredTools !== null) {
    setMcpServerDiscovery(server.id, { status: 'ok', tools: discoveredTools });
  }
  return server;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('buildRegistryMcpConfig — empty when no attachments', () => {
  const agent = makeAgent();
  const result = buildRegistryMcpConfig(agent.id);
  assert.deepEqual(result.servers, {});
  assert.deepEqual(result.catalog, {});
});

test('buildRegistryMcpConfig — attached server with "*" expands to discovered tools', () => {
  const agent = makeAgent();
  const tools = ['mcp__my-srv__tool_a', 'mcp__my-srv__tool_b'];
  const server = makeRegistryServer(tools);
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const updated = getMcpServerRegistry(server.id)!;
  const result = buildRegistryMcpConfig(agent.id);

  assert.ok(result.servers[updated.name], 'server transport present');
  assert.deepEqual(
    [...result.catalog[updated.name]].sort(),
    [...tools].sort(),
    'catalog uses discoveredTools when enabledTools is *',
  );
});

test('buildRegistryMcpConfig — "*" with no discovered tools yields empty catalog entry', () => {
  const agent = makeAgent();
  const server = makeRegistryServer(null); // not probed
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const updated = getMcpServerRegistry(server.id)!;
  const result = buildRegistryMcpConfig(agent.id);

  assert.ok(result.servers[updated.name], 'server transport still present');
  assert.deepEqual(result.catalog[updated.name], [], 'empty list when not probed');
});

test('buildRegistryMcpConfig — explicit tool list is used as-is', () => {
  const agent = makeAgent();
  const discoveredTools = ['mcp__srv__a', 'mcp__srv__b', 'mcp__srv__c'];
  const server = makeRegistryServer(discoveredTools);
  const explicit = ['mcp__srv__a'];
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: explicit });

  const updated = getMcpServerRegistry(server.id)!;
  const result = buildRegistryMcpConfig(agent.id);

  assert.deepEqual(result.catalog[updated.name], explicit, 'explicit list preserved');
});

test('buildRegistryMcpConfig — multiple attachments each produce an entry', () => {
  const agent = makeAgent();
  const tools1 = ['mcp__s1__t1'];
  const tools2 = ['mcp__s2__t2', 'mcp__s2__t3'];
  const server1 = makeRegistryServer(tools1);
  const server2 = makeRegistryServer(tools2);
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server1.id, enabledTools: '*' });
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server2.id, enabledTools: '*' });

  const s1 = getMcpServerRegistry(server1.id)!;
  const s2 = getMcpServerRegistry(server2.id)!;
  const result = buildRegistryMcpConfig(agent.id);

  assert.ok(result.servers[s1.name]);
  assert.ok(result.servers[s2.name]);
  assert.deepEqual([...result.catalog[s1.name]].sort(), [...tools1].sort());
  assert.deepEqual([...result.catalog[s2.name]].sort(), [...tools2].sort());
});

test('wildcard expansion uses registry catalog — mcp__server__* resolves to discovered tools', () => {
  const agent = makeAgent();
  const tools = ['mcp__my-registry-srv__read', 'mcp__my-registry-srv__write'];
  const server = makeRegistryServer(tools);
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const updated = getMcpServerRegistry(server.id)!;
  const { catalog } = buildRegistryMcpConfig(agent.id);

  // Simulate what pod-spawn does: merge catalog and expand wildcards.
  const merged = { 'pc-rig': ['mcp__pc-rig__pc_get_work_item'], ...catalog };
  const agentTools = [`mcp__${updated.name}__*`];
  const expanded = expandToolWildcards(agentTools, merged);

  assert.deepEqual([...expanded].sort(), [...tools].sort());
});
