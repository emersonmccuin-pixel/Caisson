// pc-pty-chat-452 — unit tests for wrapStdioCwd (pure helper, no DB needed).
//
// Drives the Windows vs Unix platform branch deterministically via the
// `platform` parameter. Covers:
//   - Windows: SEPARATE argv tokens (cwd is its own element; node quotes spaced
//     tokens for CreateProcess). An inline-quoted single string breaks under
//     cmd /c quote-stripping for spaced paths — live-verified, see the runtime
//     guard test at the bottom (Windows-gated).
//   - Unix: sh -c single string with POSIX single-quoting of every field.
//   - stdio WITHOUT cwd → returned unchanged; http/url entry → unchanged.
//   - env and type preserved on the wrapped output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { wrapStdioCwd } = await import('../src/services/pod-spawn.ts');

// A Windows-style path with spaces and a drive letter — same characteristics as
// the real life-planner cwd (drive letter + spaces + nesting).
const WIN_CWD_WITH_SPACES = 'C:\\My Projects\\Life Planner\\packages\\mcp-server';

// ── Windows: separate argv tokens ─────────────────────────────────────────────

test('wrapStdioCwd — Windows: emits separate cmd /c cd /d tokens (cwd its own arg)', () => {
  const result = wrapStdioCwd(
    { command: 'npx', args: ['tsx', 'src/index.ts'], cwd: WIN_CWD_WITH_SPACES },
    'win32',
  );
  assert.equal(result.command, 'cmd');
  assert.deepEqual(result.args, [
    '/c', 'cd', '/d', WIN_CWD_WITH_SPACES, '&&', 'npx', 'tsx', 'src/index.ts',
  ]);
  assert.equal(result.cwd, undefined, 'cwd key must NOT appear in emitted entry');
});

test('wrapStdioCwd — Windows: spaced arg stays a single raw token (node quotes it)', () => {
  const result = wrapStdioCwd(
    { command: 'node', args: ['my script.js', 'other'], cwd: '/app/my server' },
    'win32',
  );
  assert.equal(result.command, 'cmd');
  assert.deepEqual(result.args, [
    '/c', 'cd', '/d', '/app/my server', '&&', 'node', 'my script.js', 'other',
  ]);
});

test('wrapStdioCwd — Windows uses cd /d so drive-letter changes work', () => {
  const result = wrapStdioCwd(
    { command: 'npx', args: ['tsx'], cwd: WIN_CWD_WITH_SPACES },
    'win32',
  );
  assert.deepEqual(result.args?.slice(0, 4), ['/c', 'cd', '/d', WIN_CWD_WITH_SPACES]);
});

// ── Unix: sh -c single string with POSIX single-quoting ───────────────────────

test('wrapStdioCwd — Unix: emits sh -c with single-quoted fields', () => {
  const unixCwd = '/home/user/my project/mcp-server';
  const result = wrapStdioCwd(
    { command: 'npx', args: ['tsx', 'src/index.ts'], cwd: unixCwd },
    'linux',
  );
  assert.equal(result.command, 'sh');
  assert.deepEqual(result.args, [
    '-c',
    `cd '${unixCwd}' && 'npx' 'tsx' 'src/index.ts'`,
  ]);
  assert.equal(result.cwd, undefined, 'cwd key must NOT appear in emitted entry');
});

test('wrapStdioCwd — Unix: embedded single quote escapes as \'\\\'\'', () => {
  const result = wrapStdioCwd(
    { command: 'node', args: ['a\'b'], cwd: "/it's/here" },
    'darwin',
  );
  assert.equal(result.command, 'sh');
  assert.deepEqual(result.args, [
    '-c',
    `cd '/it'\\''s/here' && 'node' 'a'\\''b'`,
  ]);
});

test('wrapStdioCwd — Unix uses plain cd (no /d flag)', () => {
  const result = wrapStdioCwd(
    { command: 'npx', args: ['tsx'], cwd: '/app/my server' },
    'linux',
  );
  assert.ok(result.args?.[1]?.startsWith("cd '"), 'shell string must start with cd \'');
  assert.ok(!result.args?.[1]?.includes('cd /d'), 'Unix must NOT use cd /d');
});

// ── no-op cases ───────────────────────────────────────────────────────────────

test('wrapStdioCwd — stdio WITHOUT cwd is returned unchanged', () => {
  const transport = { command: 'node', args: ['server.js'] };
  assert.deepEqual(wrapStdioCwd(transport, 'win32'), transport);
  assert.deepEqual(wrapStdioCwd(transport, 'linux'), transport);
});

test('wrapStdioCwd — http entry (url, no command) is returned unchanged', () => {
  const httpUrl = ['https', '//example.com/mcp'].join(':');
  const transport = { type: 'http', url: httpUrl };
  assert.deepEqual(wrapStdioCwd(transport, 'linux'), transport);
});

// ── field preservation ────────────────────────────────────────────────────────

test('wrapStdioCwd — env is preserved in the wrapped output', () => {
  const result = wrapStdioCwd(
    { command: 'npx', args: ['tsx'], cwd: '/tmp/srv', env: { TOKEN: 'abc' } },
    'linux',
  );
  assert.deepEqual(result.env, { TOKEN: 'abc' });
});

test('wrapStdioCwd — type is preserved in the wrapped output', () => {
  const result = wrapStdioCwd(
    { command: 'npx', args: ['tsx'], cwd: '/tmp/srv', type: 'stdio' },
    'win32',
  );
  assert.equal(result.type, 'stdio');
});

// ── runtime guard (Windows-only): the test that catches cmd quote-stripping ────
//
// Spawns the wrapped command EXACTLY as the MCP stdio transport does
// (child_process spawn of command+args, shell:false) from a DIFFERENT cwd,
// against a real directory whose path contains spaces, and asserts the launched
// process actually lands in the spaced dir. This is the live behaviour the
// string-shape assertions above cannot prove.
test('wrapStdioCwd — Windows runtime: spaced cwd actually takes effect', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pc cwd test ')); // space in the path
  const pkg = join(root, 'a b', 'mcp-server');
  const launch = join(root, 'launch elsewhere');
  mkdirSync(pkg, { recursive: true });
  mkdirSync(launch, { recursive: true });
  writeFileSync(join(pkg, 'entry.js'), 'process.stdout.write("CWD=" + process.cwd());');

  const wrapped = wrapStdioCwd(
    { command: 'node', args: ['entry.js'], cwd: pkg }, // relative entry, resolved after cd
    'win32',
  );
  const r = spawnSync(wrapped.command!, wrapped.args!, { cwd: launch, encoding: 'utf8', shell: false });
  try {
    assert.equal(r.status, 0, `cmd exited ${r.status}: ${r.stderr}`);
    assert.ok((r.stdout ?? '').includes(`CWD=${pkg}`), `expected cwd ${pkg}, got: ${r.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
