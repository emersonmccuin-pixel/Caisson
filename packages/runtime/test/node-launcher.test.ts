// Pin the node-launcher resolution branches + the hook shell-prefix form.
// The packaged branches matter most: a fresh user machine has NO system node,
// so hooks must run via the app's own Electron binary (ELECTRON_RUN_AS_NODE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNodeLauncher, nodeShellCommand } from '../src/node-launcher.ts';

test('PC_NODE_LAUNCHER override wins, no extra env', () => {
  const l = resolveNodeLauncher({ PC_NODE_LAUNCHER: 'custom-node' }, '/app/Caisson', true);
  assert.deepEqual(l, { command: 'custom-node', env: {} });
});

test('Electron proper → execPath + ELECTRON_RUN_AS_NODE', () => {
  const l = resolveNodeLauncher({}, 'C:\\Program Files\\Caisson\\Caisson.exe', true);
  assert.equal(l.command, 'C:\\Program Files\\Caisson\\Caisson.exe');
  assert.deepEqual(l.env, { ELECTRON_RUN_AS_NODE: '1' });
});

test('bundle-child (ELECTRON_RUN_AS_NODE in env, versions.electron absent) → execPath + flag', () => {
  const l = resolveNodeLauncher(
    { ELECTRON_RUN_AS_NODE: '1' },
    'C:\\Program Files\\Caisson\\Caisson.exe',
    false,
  );
  assert.equal(l.command, 'C:\\Program Files\\Caisson\\Caisson.exe');
  assert.deepEqual(l.env, { ELECTRON_RUN_AS_NODE: '1' });
});

test('plain node/tsx dev → own execPath, no extra env', () => {
  const l = resolveNodeLauncher({}, '/usr/local/bin/node', false);
  assert.deepEqual(l, { command: '/usr/local/bin/node', env: {} });
});

test('nodeShellCommand: dev form is just the quoted exe', () => {
  assert.equal(
    nodeShellCommand({ command: 'E:\\nodejs\\node.exe', env: {} }),
    '"E:/nodejs/node.exe"',
  );
});

test('nodeShellCommand: packaged form inlines the env var prefix', () => {
  assert.equal(
    nodeShellCommand({
      command: 'C:\\Program Files\\Caisson\\Caisson.exe',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }),
    'ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Caisson/Caisson.exe"',
  );
});

test('nodeShellCommand embeds into settings JSON without breaking it', () => {
  // Mirrors claude-runtime-bundle: token is JSON-escaped then substituted into
  // the raw template text. The rendered file must stay parseable and preserve
  // the shell line verbatim.
  const cmd = nodeShellCommand({
    command: 'C:\\Program Files\\Caisson\\Caisson.exe',
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  const escaped = cmd.replace(/"/g, '\\"');
  const rendered = `{"command": "${escaped} \\"/proj/.claude/hooks/event-capture.cjs\\" Stop"}`;
  const parsed = JSON.parse(rendered) as { command: string };
  assert.equal(
    parsed.command,
    'ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Caisson/Caisson.exe" "/proj/.claude/hooks/event-capture.cjs" Stop',
  );
});
