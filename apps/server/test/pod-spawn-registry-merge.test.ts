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
  createProject,
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

function makeProject() {
  const slug = 'test-proj-' + Date.now() + '-' + Math.random();
  return createProject({
    slug,
    name: slug,
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: join(tmpdir(), slug),
  });
}

function makeProjectScopedServer(projectId: string, discoveredTools: string[] | null = null) {
  const server = createMcpServerRegistry({
    scope: 'project',
    projectId: projectId as import('@pc/domain').ULID,
    name: 'proj-srv-' + Date.now() + '-' + Math.random(),
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

// ── pc-pty-chat-450: project-scope filter ─────────────────────────────────────

test('buildRegistryMcpConfig — project-scoped server resolves when spawnProjectId matches', () => {
  const agent = makeAgent();
  const project = makeProject();
  const tools = ['mcp__proj-srv__read'];
  const server = makeProjectScopedServer(project.id, tools);
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const updated = getMcpServerRegistry(server.id)!;
  const result = buildRegistryMcpConfig(agent.id, project.id as import('@pc/domain').ULID);

  assert.ok(result.servers[updated.name], 'server transport present when projectId matches');
  assert.deepEqual(
    [...result.catalog[updated.name]].sort(),
    [...tools].sort(),
    'catalog populated when projectId matches',
  );
});

test('buildRegistryMcpConfig — project-scoped server is skipped when spawnProjectId differs', () => {
  const agent = makeAgent();
  const project = makeProject();
  const otherProject = makeProject();
  const tools = ['mcp__proj-srv__write'];
  const server = makeProjectScopedServer(project.id, tools);
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const updated = getMcpServerRegistry(server.id)!;
  const result = buildRegistryMcpConfig(agent.id, otherProject.id as import('@pc/domain').ULID);

  assert.equal(result.servers[updated.name], undefined, 'server absent when projectId differs');
  assert.equal(result.catalog[updated.name], undefined, 'catalog absent when projectId differs');
});

test('buildRegistryMcpConfig — global server resolves for any spawnProjectId including null', () => {
  const agent = makeAgent();
  const project = makeProject();
  const tools = ['mcp__global-srv__ping'];
  const server = makeRegistryServer(tools);
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: '*' });

  const updated = getMcpServerRegistry(server.id)!;

  // null spawnProjectId
  const r1 = buildRegistryMcpConfig(agent.id, null);
  assert.ok(r1.servers[updated.name], 'global server resolves with null spawnProjectId');

  // arbitrary projectId
  const r2 = buildRegistryMcpConfig(agent.id, project.id as import('@pc/domain').ULID);
  assert.ok(r2.servers[updated.name], 'global server resolves with a project spawnProjectId');
});

// ── pc-pty-chat-451: orchestrator auto-include project servers ────────────────

test('buildRegistryMcpConfig — includeProjectServers:true merges project-scoped servers (no attachment row)', () => {
  const agent = makeAgent();
  const project = makeProject();
  const tools = ['mcp__auto-srv__read', 'mcp__auto-srv__write'];
  const server = makeProjectScopedServer(project.id, tools);
  // Deliberately no upsertMcpAttachment call — server is only registered.

  const updated = getMcpServerRegistry(server.id)!;
  const result = buildRegistryMcpConfig(
    agent.id,
    project.id as import('@pc/domain').ULID,
    { includeProjectServers: true },
  );

  assert.ok(result.servers[updated.name], 'server included without explicit attachment');
  assert.deepEqual(
    [...result.catalog[updated.name]].sort(),
    [...tools].sort(),
    'catalog uses discoveredTools (* semantics)',
  );
});

test('buildRegistryMcpConfig — includeProjectServers:false (worker default) does NOT auto-include', () => {
  const agent = makeAgent();
  const project = makeProject();
  const tools = ['mcp__worker-srv__op'];
  const server = makeProjectScopedServer(project.id, tools);

  const updated = getMcpServerRegistry(server.id)!;
  // default opts (no includeProjectServers)
  const result = buildRegistryMcpConfig(agent.id, project.id as import('@pc/domain').ULID);

  assert.equal(result.servers[updated.name], undefined, 'server absent without includeProjectServers');
  assert.equal(result.catalog[updated.name], undefined, 'catalog absent without includeProjectServers');
});

test('buildRegistryMcpConfig — includeProjectServers dedupes: attachment enabledTools wins over auto-include', () => {
  const agent = makeAgent();
  const project = makeProject();
  const discoveredTools = ['mcp__dup-srv__a', 'mcp__dup-srv__b', 'mcp__dup-srv__c'];
  const server = makeProjectScopedServer(project.id, discoveredTools);
  // Attach with an explicit tool subset — this should win over discoveredTools.
  const explicitTools = ['mcp__dup-srv__a'];
  upsertMcpAttachment({ agentId: agent.id, mcpServerId: server.id, enabledTools: explicitTools });

  const updated = getMcpServerRegistry(server.id)!;
  const result = buildRegistryMcpConfig(
    agent.id,
    project.id as import('@pc/domain').ULID,
    { includeProjectServers: true },
  );

  assert.deepEqual(
    result.catalog[updated.name],
    explicitTools,
    'explicit attachment enabledTools wins over auto-include discoveredTools',
  );
});

test('buildRegistryMcpConfig — global servers are NOT auto-included by includeProjectServers', () => {
  const agent = makeAgent();
  const project = makeProject();
  // Create a global server — NOT attached to the agent, NOT project-scoped.
  const globalServer = makeRegistryServer(['mcp__global-auto__op']);

  const updated = getMcpServerRegistry(globalServer.id)!;
  const result = buildRegistryMcpConfig(
    agent.id,
    project.id as import('@pc/domain').ULID,
    { includeProjectServers: true },
  );

  assert.equal(
    result.servers[updated.name],
    undefined,
    'global server not auto-included even with includeProjectServers:true',
  );
});

test('buildRegistryMcpConfig — server registered after first spawn appears on next (resume) spawn config', () => {
  // Simulates resume pickup: buildRegistryMcpConfig always reads live DB state,
  // so a server registered after the initial spawn is included on the next call.
  const agent = makeAgent();
  const project = makeProject();

  // First "spawn" — no project servers yet.
  const firstResult = buildRegistryMcpConfig(
    agent.id,
    project.id as import('@pc/domain').ULID,
    { includeProjectServers: true },
  );
  const before = Object.keys(firstResult.servers).length;

  // Register a server after the first spawn.
  const tools = ['mcp__late-srv__ping'];
  const server = makeProjectScopedServer(project.id, tools);
  const updated = getMcpServerRegistry(server.id)!;

  // Second "spawn" (resume) — reads fresh DB state.
  const secondResult = buildRegistryMcpConfig(
    agent.id,
    project.id as import('@pc/domain').ULID,
    { includeProjectServers: true },
  );

  assert.equal(Object.keys(secondResult.servers).length, before + 1, 'one more server on resume');
  assert.ok(secondResult.servers[updated.name], 'newly registered server present on resume spawn');
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
