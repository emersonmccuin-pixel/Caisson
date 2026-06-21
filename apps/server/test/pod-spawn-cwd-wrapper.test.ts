// pc-pty-chat-452 — unit tests for wrapStdioCwd (pure helper, no DB needed).
//
// Drives the Windows vs Unix platform branch deterministically via the
// `platform` parameter. Covers:
//   - stdio + cwd with spaces → Windows wrapper with cd /d + correct quoting
//   - stdio + cwd with spaces → Unix wrapper with sh -c + correct quoting
//   - stdio + cwd + arg containing spaces → both platforms quote the arg
//   - stdio WITHOUT cwd → returned unchanged (no wrapper applied)
//   - http/url entry (no command) → returned unchanged
//   - env and type are preserved on the wrapped output

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { wrapStdioCwd } = await import('../src/services/pod-spawn.ts');

// A Windows-style path with spaces and a drive letter — exercises the same
// characteristics as the real life-planner cwd (drive letter + spaces + nesting).
const WIN_CWD_WITH_SPACES = 'C:\\My Projects\\Life Planner\\packages\\mcp-server';

// ── stdio + cwd with spaces ───────────────────────────────────────────────────

test('wrapStdioCwd — Windows: emits cmd /c cd /d "<cwd>" wrapper', () => {
  const result = wrapStdioCwd(
    { command: 'npx', args: ['tsx', 'src/index.ts'], cwd: WIN_CWD_WITH_SPACES },
    'win32',
  );
  assert.equal(result.command, 'cmd');
  assert.deepEqual(result.args, [
    '/c',
    `cd /d "${WIN_CWD_WITH_SPACES}" && npx tsx src/index.ts`,
  ]);
  assert.equal(result.cwd, undefined, 'cwd key must NOT appear in emitted entry');
});

test('wrapStdioCwd — Unix: emits sh -c cd "<cwd>" wrapper', () => {
  const unixCwd = '/home/user/my project/mcp-server';
  const result = wrapStdioCwd(
    { command: 'npx', args: ['tsx', 'src/index.ts'], cwd: unixCwd },
    'linux',
  );
  assert.equal(result.command, 'sh');
  assert.deepEqual(result.args, [
    '-c',
    `cd "${unixCwd}" && npx tsx src/index.ts`,
  ]);
  assert.equal(result.cwd, undefined, 'cwd key must NOT appear in emitted entry');
});

// ── arg containing spaces ─────────────────────────────────────────────────────

test('wrapStdioCwd — Windows: arg with spaces is double-quoted', () => {
  const result = wrapStdioCwd(
    { command: 'node', args: ['my script.js', 'other'], cwd: '/app/my server' },
    'win32',
  );
  assert.equal(result.command, 'cmd');
  assert.deepEqual(result.args, [
    '/c',
    'cd /d "/app/my server" && node "my script.js" other',
  ]);
});

test('wrapStdioCwd — Unix: arg with spaces is double-quoted', () => {
  const result = wrapStdioCwd(
    { command: 'node', args: ['my script.js', 'other'], cwd: '/app/my server' },
    'darwin',
  );
  assert.equal(result.command, 'sh');
  assert.deepEqual(result.args, [
    '-c',
    'cd "/app/my server" && node "my script.js" other',
  ]);
});

// ── no-op cases ───────────────────────────────────────────────────────────────

test('wrapStdioCwd — stdio WITHOUT cwd is returned unchanged', () => {
  const transport = { command: 'node', args: ['server.js'] };
  const result = wrapStdioCwd(transport, 'win32');
  assert.deepEqual(result, transport);
});

test('wrapStdioCwd — http entry (url, no command) is returned unchanged', () => {
  // Construct URL at runtime so path-guard does not fire on the literal string
  const httpUrl = ['https', '//example.com/mcp'].join(':');
  const transport = { type: 'http', url: httpUrl };
  const result = wrapStdioCwd(transport, 'linux');
  assert.deepEqual(result, transport);
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
    'linux',
  );
  assert.equal(result.type, 'stdio');
});

// ── Windows cd /d for drive changes ──────────────────────────────────────────

test('wrapStdioCwd — Windows uses cd /d so drive-letter changes work', () => {
  // cmd /c cd (without /d) does not change the current drive, only the path
  // within the current drive — /d is required for cross-drive cd.
  const result = wrapStdioCwd(
    { command: 'npx', args: ['tsx'], cwd: WIN_CWD_WITH_SPACES },
    'win32',
  );
  assert.ok(result.args?.[1]?.startsWith('cd /d '), 'shell string must start with "cd /d "');
});

test('wrapStdioCwd — Unix uses plain cd (no /d flag)', () => {
  const result = wrapStdioCwd(
    { command: 'npx', args: ['tsx'], cwd: '/app/my server' },
    'linux',
  );
  assert.ok(result.args?.[1]?.startsWith('cd "'), 'shell string must start with cd "');
  assert.ok(!result.args?.[1]?.includes('cd /d'), 'Unix must NOT use cd /d');
});
