// Slice 6 guardrail — deterministic verifier env: explicit PATH + local node_modules/.bin
//
// Principle 2b (pc-pty-chat-374.6): createWorktreeExecutors.runBash must execute
// with an EXPLICIT, deterministic env where PATH is prepended with:
//   1. <worktreeDir>/node_modules/.bin
//   2. <projectFolderPath>/node_modules/.bin
//
// DECISION (locked, minimal scope): DO NOT capture the agent's spawn env or any
// secrets. Reconstruct a sane env from process.env ONLY, prepending the local
// .bin dirs for consistent toolchain resolution.
//
// Test strategy: rather than reading $PATH as a string (TAIL_CAP truncates the
// head where our prepended entries land), we write a tiny node script that
// checks whether a specific dir is present in PATH and exits 0/1. Exit code is
// reliable and unaffected by PATH length.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

import { createWorktreeExecutors } from '../src/services/agent-verification.ts';

/** Write a node script that exits 0 when all expected dirs are in PATH in the
 *  correct order, and exits 1 (with a diagnostic to stderr) otherwise. */
function makeCheckScript(scriptDir: string, ...expectedDirs: string[]): string {
  const scriptPath = join(scriptDir, '_checkpath.js');
  // Build the script body as a single-quoted template to avoid shell issues.
  const body = `
const d = require('path').delimiter;
const p = (process.env.PATH || process.env.Path || '').split(d).map(e => e.toLowerCase());
const expected = ${JSON.stringify(expectedDirs.map((e) => e.toLowerCase()))};
// Check all expected dirs are present
const missing = expected.filter(e => !p.includes(e));
if (missing.length) {
  process.stderr.write('MISSING in PATH: ' + missing.join(', ') + '\\n');
  process.stderr.write('PATH[:300]: ' + (process.env.PATH || process.env.Path || '').slice(0, 300) + '\\n');
  process.exit(1);
}
// Check ordering: each expected[i] must appear before expected[i+1]
for (let i = 0; i < expected.length - 1; i++) {
  const ia = p.indexOf(expected[i]);
  const ib = p.indexOf(expected[i + 1]);
  if (ia > ib) {
    process.stderr.write('ORDER WRONG: ' + expected[i] + ' at ' + ia + ' must be before ' + expected[i + 1] + ' at ' + ib + '\\n');
    process.exit(2);
  }
}
process.exit(0);
`;
  writeFileSync(scriptPath, body);
  return scriptPath;
}

// ── (a) worktree node_modules/.bin is prepended to PATH ──────────────────────

test('runBash env: worktree node_modules/.bin appears in PATH', async () => {
  const worktreeDir = mkdtempSync(join(tmpdir(), 'pc-runbash-env-'));
  const binDir = join(worktreeDir, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  try {
    const scriptPath = makeCheckScript(worktreeDir, binDir);
    const exec = createWorktreeExecutors({ worktreeDir, projectFolderPath: worktreeDir });
    const result = await exec.runBash(`node ${JSON.stringify(scriptPath)}`, 'worktree');
    assert.equal(
      result.exitCode,
      0,
      `worktree node_modules/.bin must be in PATH; stderr: ${result.stderrTail ?? ''}`,
    );
  } finally {
    rmSync(worktreeDir, { recursive: true, force: true });
  }
});

// ── (a) project-root node_modules/.bin is also prepended ─────────────────────

test('runBash env: project-root node_modules/.bin also appears in PATH', async () => {
  const worktreeDir = mkdtempSync(join(tmpdir(), 'pc-runbash-env-wt-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pc-runbash-env-proj-'));
  const worktreeBin = join(worktreeDir, 'node_modules', '.bin');
  const projectBin = join(projectDir, 'node_modules', '.bin');
  mkdirSync(worktreeBin, { recursive: true });
  mkdirSync(projectBin, { recursive: true });
  try {
    const scriptPath = makeCheckScript(worktreeDir, worktreeBin, projectBin);
    const exec = createWorktreeExecutors({ worktreeDir, projectFolderPath: projectDir });
    const result = await exec.runBash(`node ${JSON.stringify(scriptPath)}`, 'worktree');
    assert.equal(
      result.exitCode,
      0,
      `both .bin dirs must be in PATH; stderr: ${result.stderrTail ?? ''}`,
    );
  } finally {
    rmSync(worktreeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ── worktree .bin is PREPENDED (comes before the inherited PATH entries) ──────

test('runBash env: worktree .bin appears before project .bin in PATH', async () => {
  const worktreeDir = mkdtempSync(join(tmpdir(), 'pc-runbash-env-ord-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'pc-runbash-env-ord-p-'));
  const worktreeBin = join(worktreeDir, 'node_modules', '.bin');
  const projectBin = join(projectDir, 'node_modules', '.bin');
  mkdirSync(worktreeBin, { recursive: true });
  mkdirSync(projectBin, { recursive: true });
  try {
    // makeCheckScript also checks ordering: worktreeBin must come before projectBin
    const scriptPath = makeCheckScript(worktreeDir, worktreeBin, projectBin);
    const exec = createWorktreeExecutors({ worktreeDir, projectFolderPath: projectDir });
    const result = await exec.runBash(`node ${JSON.stringify(scriptPath)}`, 'worktree');
    assert.equal(
      result.exitCode,
      0,
      `worktree .bin must precede project .bin in PATH; stderr: ${result.stderrTail ?? ''}`,
    );
  } finally {
    rmSync(worktreeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ── (b) env is explicit: spawn does NOT receive undefined ────────────────────
// Proven: a randomly-named temp binDir that cannot already be in process.env.PATH
// appears in the child PATH only if we explicitly passed env to spawn.

test('runBash env: spawned process sees .bin even when it is absent from the server PATH', async () => {
  const worktreeDir = mkdtempSync(join(tmpdir(), 'pc-runbash-env-xplicit-'));
  const binDir = join(worktreeDir, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  try {
    // Sanity: assert the server itself does NOT have this random dir in PATH
    const serverPath = (process.env.PATH ?? process.env.Path ?? '').toLowerCase();
    const alreadyInServerPath = serverPath
      .split(delimiter)
      .some((e) => e === binDir.toLowerCase());
    // If somehow already present, the test is vacuous — log and continue.
    if (alreadyInServerPath) {
      // eslint-disable-next-line no-console
      console.warn('WARN: random temp binDir already in server PATH; test is vacuous');
    }

    const scriptPath = makeCheckScript(worktreeDir, binDir);
    const exec = createWorktreeExecutors({ worktreeDir, projectFolderPath: worktreeDir });
    const result = await exec.runBash(`node ${JSON.stringify(scriptPath)}`, 'worktree');
    assert.equal(
      result.exitCode,
      0,
      `random temp .bin must be in child PATH — proves env is passed explicitly; stderr: ${result.stderrTail ?? ''}`,
    );
  } finally {
    rmSync(worktreeDir, { recursive: true, force: true });
  }
});
