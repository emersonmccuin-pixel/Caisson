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

// ── Windows: .cmd-shim wrapper WITHOUT cwd (pc-pty-chat-454) ───────────────────
//
// `npx`/`npm`/`pnpm`/... are Windows .cmd batch shims with no sibling .exe.
// Node's spawn (shell:false) — exactly how Claude launches a stdio MCP server —
// ENOENTs on them. They must be routed through `cmd /c` even with no cwd.

test('wrapStdioCwd — Windows: bare npx (no cwd) is wrapped through cmd /c', () => {
  const result = wrapStdioCwd(
    { command: 'npx', args: ['tsx', 'E:/Life Planning App/packages/mcp-server/src/index.ts'] },
    'win32',
  );
  assert.equal(result.command, 'cmd');
  assert.deepEqual(result.args, [
    '/c', 'npx', 'tsx', 'E:/Life Planning App/packages/mcp-server/src/index.ts',
  ]);
  assert.equal(result.cwd, undefined);
});

test('wrapStdioCwd — Windows: npm / pnpm / yarn / tsx shims (no cwd) are wrapped', () => {
  for (const shim of ['npm', 'pnpm', 'yarn', 'tsx', 'bunx']) {
    const result = wrapStdioCwd({ command: shim, args: ['x'] }, 'win32');
    assert.equal(result.command, 'cmd', `${shim} routed through cmd`);
    assert.deepEqual(result.args, ['/c', shim, 'x']);
  }
});

test('wrapStdioCwd — Windows: explicit *.cmd / *.bat (no cwd) is wrapped', () => {
  const cmd = wrapStdioCwd({ command: 'my-server.cmd', args: ['--port', '1'] }, 'win32');
  assert.equal(cmd.command, 'cmd');
  assert.deepEqual(cmd.args, ['/c', 'my-server.cmd', '--port', '1']);
  const bat = wrapStdioCwd({ command: 'run.BAT' }, 'win32');
  assert.equal(bat.command, 'cmd');
  assert.deepEqual(bat.args, ['/c', 'run.BAT']);
});

test('wrapStdioCwd — Windows: env + type preserved on the no-cwd shim wrap', () => {
  const result = wrapStdioCwd(
    { command: 'npx', args: ['tsx'], env: { TOKEN: 'abc' }, type: 'stdio' },
    'win32',
  );
  assert.deepEqual(result.env, { TOKEN: 'abc' });
  assert.equal(result.type, 'stdio');
});

// ── no-regression: direct executables WITHOUT cwd stay untouched ──────────────

test('wrapStdioCwd — Windows: bare node (no cwd) is NOT wrapped (direct .exe)', () => {
  const transport = { command: 'node', args: ['server.js'] };
  assert.deepEqual(wrapStdioCwd(transport, 'win32'), transport);
});

test('wrapStdioCwd — Windows: absolute *.exe path (no cwd) is NOT wrapped (cia-next case)', () => {
  const transport = {
    command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
    args: ['E:\\proj\\server.py'],
    env: { KEY: 'v' },
  };
  assert.deepEqual(wrapStdioCwd(transport, 'win32'), transport);
});

test('wrapStdioCwd — Unix: bare npx (no cwd) is NOT wrapped (no .cmd problem on Unix)', () => {
  const transport = { command: 'npx', args: ['tsx', 'x'] };
  assert.deepEqual(wrapStdioCwd(transport, 'linux'), transport);
  assert.deepEqual(wrapStdioCwd(transport, 'darwin'), transport);
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
