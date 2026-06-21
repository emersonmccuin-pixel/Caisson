// Slice 011 (11F) — external/per-pod MCP server config SHAPE validation.
// Config shape only; capability discovery is out of scope (plan section 14/16).
// ☠ FD-2: the applyNodeLauncher rewriter died with the stdio pc-rig child —
// the baseline is an HTTP entry now; no node launcher to swap.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePodMcpServerConfig, parseMcpServerTransport } from '../src/services/pod-mcp-config.ts';

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

// ── parsePodMcpServerConfig: cwd (pc-pty-chat-452) ──────────────────────────

test('parsePodMcpServerConfig accepts cwd on a stdio entry', () => {
  const cfg = parsePodMcpServerConfig({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    cwd: 'E:\\Claude Code Projects\\Personal\\Life Planning App\\packages\\mcp-server',
  });
  assert.equal(cfg.cwd, 'E:\\Claude Code Projects\\Personal\\Life Planning App\\packages\\mcp-server');
  assert.equal(cfg.command, 'npx');
});

test('parsePodMcpServerConfig rejects cwd paired with url (http entry)', () => {
  assert.throws(
    () => parsePodMcpServerConfig({ url: 'https://x.test/mcp', cwd: '/some/path' }),
    /mcp\.cwd is only valid with command/,
  );
});

test('parsePodMcpServerConfig rejects empty cwd', () => {
  assert.throws(
    () => parsePodMcpServerConfig({ command: 'npx', cwd: '   ' }),
    /mcp\.cwd must not be empty/,
  );
});

test('parsePodMcpServerConfig rejects non-string cwd', () => {
  assert.throws(
    () => parsePodMcpServerConfig({ command: 'npx', cwd: 42 }),
    /mcp\.cwd must be a string/,
  );
});

// ── parseMcpServerTransport: cwd (pc-pty-chat-452) ──────────────────────────

test('parseMcpServerTransport accepts cwd on a stdio entry', () => {
  const t = parseMcpServerTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    cwd: '/home/user/my project/mcp-server',
  });
  assert.equal(t.cwd, '/home/user/my project/mcp-server');
  assert.equal(t.command, 'npx');
});

test('parseMcpServerTransport rejects cwd paired with url (http entry)', () => {
  assert.throws(
    () => parseMcpServerTransport({ url: 'https://x.test/mcp', cwd: '/some/path' }),
    /mcp\.cwd is only valid with command/,
  );
});

test('parseMcpServerTransport rejects empty cwd', () => {
  assert.throws(
    () => parseMcpServerTransport({ command: 'npx', cwd: '' }),
    /mcp\.cwd must not be empty/,
  );
});

