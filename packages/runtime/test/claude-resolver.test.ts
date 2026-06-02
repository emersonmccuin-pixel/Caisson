// Section 10 — resolver precedence for the bundled (pinned, app-shipped) CLI.
// Run via:  pnpm --filter @pc/runtime test

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  resolveClaudeBinary,
  setBundledClaudeExe,
  setConfiguredClaudeExe,
} from '../src/claude-resolver.ts';

// Module state is process-global; reset every override + the CLAUDE_EXE env so
// tests don't bleed into each other.
afterEach(() => {
  setConfiguredClaudeExe(null);
  setBundledClaudeExe(null);
  delete process.env.CLAUDE_EXE;
});

const BUNDLED = '/app/resources/claude/claude.exe';
const seeBundled = () => BUNDLED; // probe seam: pretend the bundled file exists

test('bundled is used when no explicit override/config/env is set', () => {
  setBundledClaudeExe(BUNDLED);
  const r = resolveClaudeBinary({
    probeBundled: seeBundled,
    probePath: () => '/usr/bin/claude',
    probeHomedir: () => '/home/u/.local/bin/claude',
  });
  assert.deepEqual(r, { path: BUNDLED, source: 'bundled' });
});

test('bundled beats PATH and ~/.local/bin', () => {
  setBundledClaudeExe(BUNDLED);
  const r = resolveClaudeBinary({
    probeBundled: seeBundled,
    probePath: () => '/usr/bin/claude',
    probeHomedir: () => '/home/u/.local/bin/claude',
  });
  assert.equal(r.path, BUNDLED);
});

test('explicit override wins over bundled', () => {
  setBundledClaudeExe(BUNDLED);
  const r = resolveClaudeBinary({ override: '/explicit/claude', probeBundled: seeBundled });
  assert.deepEqual(r, { path: '/explicit/claude', source: 'override' });
});

test('configured claudeExe setting wins over bundled', () => {
  setConfiguredClaudeExe('/config/claude');
  setBundledClaudeExe(BUNDLED);
  const r = resolveClaudeBinary({ probeBundled: seeBundled });
  assert.deepEqual(r, { path: '/config/claude', source: 'config' });
});

test('CLAUDE_EXE env wins over bundled', () => {
  process.env.CLAUDE_EXE = '/env/claude';
  setBundledClaudeExe(BUNDLED);
  const r = resolveClaudeBinary({ probeBundled: seeBundled });
  assert.deepEqual(r, { path: '/env/claude', source: 'env' });
});

test('missing/dev bundle (not set) falls through to PATH', () => {
  const r = resolveClaudeBinary({
    probePath: () => '/usr/bin/claude',
    probeHomedir: () => null,
  });
  assert.deepEqual(r, { path: '/usr/bin/claude', source: 'path' });
});

test('a set-but-nonexistent bundled path falls through to PATH', () => {
  setBundledClaudeExe('/does/not/exist/claude.exe');
  // No probeBundled seam → real existsSync runs → the fake path is absent.
  const r = resolveClaudeBinary({
    probePath: () => '/usr/bin/claude',
    probeHomedir: () => null,
  });
  assert.deepEqual(r, { path: '/usr/bin/claude', source: 'path' });
});

test('setBundledClaudeExe trims; empty clears it', () => {
  setBundledClaudeExe(`  ${BUNDLED}  `);
  assert.equal(resolveClaudeBinary({ probeBundled: seeBundled }).path, BUNDLED);
  setBundledClaudeExe('   ');
  const r = resolveClaudeBinary({ probePath: () => null, probeHomedir: () => null });
  assert.deepEqual(r, { path: null, source: 'not-found' });
});
