// Slice 011 (11F) — external/per-pod MCP server config SHAPE validation +
// boot-time .mcp.json rewriter suffix-match behavior. Config shape only;
// capability discovery is out of scope (plan section 14/16).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { parsePodMcpServerConfig } from '../src/services/pod-mcp-config.ts';
import { rewriteStaleMcpConfigs, applyNodeLauncher } from '../src/services/mcp-config-rewrite.ts';

// ── parsePodMcpServerConfig: valid shapes accepted ──────────────────────────

test('accepts a stdio config { command, args, env }', () => {
  const cfg = parsePodMcpServerConfig({
    command: 'node',
    args: ['server.js'],
    env: { TOKEN: 'abc' },
  });
  assert.deepEqual(cfg, { command: 'node', args: ['server.js'], env: { TOKEN: 'abc' } });
});

test('accepts a minimal stdio config { command }', () => {
  assert.deepEqual(parsePodMcpServerConfig({ command: 'node' }), { command: 'node' });
});

test('accepts an HTTP config { url }', () => {
  assert.deepEqual(parsePodMcpServerConfig({ url: 'https://x.test/mcp' }), {
    url: 'https://x.test/mcp',
  });
});

// ── parsePodMcpServerConfig: malformed shapes rejected ──────────────────────

test('rejects a non-object config', () => {
  assert.throws(() => parsePodMcpServerConfig('nope'), /must be an object/);
  assert.throws(() => parsePodMcpServerConfig(null), /must be an object/);
  assert.throws(() => parsePodMcpServerConfig([]), /must be an object/);
});

test('rejects a config with neither command nor url', () => {
  assert.throws(() => parsePodMcpServerConfig({}), /requires either command/);
  assert.throws(() => parsePodMcpServerConfig({ env: { A: 'b' } }), /requires either command/);
});

test('rejects a config that sets both command and url', () => {
  assert.throws(
    () => parsePodMcpServerConfig({ command: 'node', url: 'https://x.test' }),
    /must not set both command and url/,
  );
});

test('rejects args/env paired with a url (http has no stdio args)', () => {
  assert.throws(
    () => parsePodMcpServerConfig({ url: 'https://x.test', args: ['x'] }),
    /only valid with command/,
  );
  assert.throws(
    () => parsePodMcpServerConfig({ url: 'https://x.test', env: { A: 'b' } }),
    /only valid with command/,
  );
});

test('rejects empty command / url strings', () => {
  assert.throws(() => parsePodMcpServerConfig({ command: '   ' }), /command must not be empty/);
  assert.throws(() => parsePodMcpServerConfig({ url: '' }), /url must not be empty/);
});

test('rejects wrong types for command / args / env / url', () => {
  assert.throws(() => parsePodMcpServerConfig({ command: 5 }), /command must be a string/);
  assert.throws(() => parsePodMcpServerConfig({ command: 'n', args: 'x' }), /args must be string/);
  assert.throws(
    () => parsePodMcpServerConfig({ command: 'n', args: [1] }),
    /args must be string/,
  );
  assert.throws(
    () => parsePodMcpServerConfig({ command: 'n', env: { A: 5 } }),
    /env\.A must be a string/,
  );
  assert.throws(() => parsePodMcpServerConfig({ url: 5 }), /url must be a string/);
});

// ── rewriteStaleMcpConfigs: suffix-match behavior unchanged ──────────────────

test('rewrites a stale npx/tsx pc-rig entry to the bundle path', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mcp-cfg-'));
  try {
    const trunk = '/abs/trunk';
    writeFileSync(
      resolve(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'pc-rig': { command: 'npx', args: ['-y', 'tsx', `${trunk}/packages/mcp/src/server.ts`] },
        },
      }),
    );
    const result = rewriteStaleMcpConfigs([dir]);
    assert.equal(result.rewritten.length, 1);
    const after = JSON.parse(readFileSync(resolve(dir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { 'pc-rig': { command: string; args: string[] } };
    };
    assert.equal(after.mcpServers['pc-rig'].command, 'node');
    assert.deepEqual(after.mcpServers['pc-rig'].args, [`${trunk}/packages/mcp/dist/server.mjs`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skips an already-rewritten (bundle path) pc-rig entry', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mcp-cfg-'));
  try {
    writeFileSync(
      resolve(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'pc-rig': { command: 'node', args: ['/abs/trunk/packages/mcp/dist/server.mjs'] },
        },
      }),
    );
    const result = rewriteStaleMcpConfigs([dir]);
    assert.equal(result.rewritten.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyNodeLauncher only touches PC-node servers (suffix match), leaves foreign ones', () => {
  const config = {
    mcpServers: {
      'pc-rig': { command: 'oldnode', args: ['/x/packages/mcp/dist/server.mjs'] },
      gmail: { command: 'python', args: ['gmail_server.py'] },
    },
  };
  const changed = applyNodeLauncher(config, { command: 'node', env: {} });
  assert.equal(changed, true);
  assert.equal(config.mcpServers['pc-rig'].command, 'node');
  assert.equal(config.mcpServers.gmail.command, 'python'); // foreign untouched
});
