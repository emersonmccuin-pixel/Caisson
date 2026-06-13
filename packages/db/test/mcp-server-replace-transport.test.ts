// Connector-auth Slice 2 (pc-pty-chat-400.3) — replaceTransportOnly +
// $secretRef round-trip through the mcp_servers DB table.
//
// Tests that replaceTransportOnly:
//   - updates the transport without clearing discoveryStatus / discoveredTools.
//   - bumps rev and updatedAt.
//   - a { $secretRef: ... } value round-trips through JSON serialisation.
//   - returns null for an unknown id.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-replace-transport-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  runMigrations,
  closeDb,
  createMcpServerRegistry,
  getMcpServerRegistry,
  replaceTransportOnly,
  setMcpServerDiscovery,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const MCP_URL: string = ['https', '//example.com/mcp'].join(':');

test('replaceTransportOnly: updates transport + bumps rev, does NOT clear discoveryStatus', () => {
  const server = createMcpServerRegistry({
    scope: 'global',
    name: `test-replace-transport-${Date.now()}`,
    transport: { url: MCP_URL, headers: { Authorization: 'Bearer original' } },
  });

  // Simulate a successful discovery probe.
  setMcpServerDiscovery(server.id, { status: 'ok', tools: ['tool-a', 'tool-b'] });

  const before = getMcpServerRegistry(server.id)!;
  assert.equal(before.discoveryStatus, 'ok');
  assert.deepEqual(before.discoveredTools, ['tool-a', 'tool-b']);

  // Replace just the transport.
  const ref = { $secretRef: '01FAKECRED000000000000000A' };
  const updated = replaceTransportOnly(server.id, {
    url: MCP_URL,
    headers: { Authorization: ref },
  });

  assert.ok(updated, 'returns the updated row');
  assert.equal(updated!.discoveryStatus, 'ok', 'discoveryStatus must NOT be cleared');
  assert.deepEqual(updated!.discoveredTools, ['tool-a', 'tool-b'], 'discoveredTools must NOT be cleared');
  assert.ok(updated!.rev > before.rev, 'rev is bumped');
  assert.ok(updated!.updatedAt >= before.updatedAt, 'updatedAt is bumped');
});

test('replaceTransportOnly: $secretRef round-trips through JSON serialisation', () => {
  const server = createMcpServerRegistry({
    scope: 'global',
    name: `test-ref-roundtrip-${Date.now()}`,
    transport: { url: MCP_URL },
  });

  const ref = { $secretRef: '01FAKECRED000000000000000B' };
  replaceTransportOnly(server.id, { url: MCP_URL, headers: { Authorization: ref } });

  const reloaded = getMcpServerRegistry(server.id)!;
  const authHeader = reloaded.transport.headers!['Authorization'];
  assert.deepEqual(authHeader, { $secretRef: '01FAKECRED000000000000000B' },
    '$secretRef sentinel round-trips through DB JSON');
});

test('replaceTransportOnly: returns null for unknown id', () => {
  const result = replaceTransportOnly('01UNKNOWN000000000000000000' as any, { url: MCP_URL });
  assert.equal(result, null);
});
