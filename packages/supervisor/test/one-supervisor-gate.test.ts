// Step 7 — the ONE-SUPERVISOR static gate.
//
// Invariant (supervisor-build-scope-2026-06-03): there is exactly ONE process
// supervisor — Electron main running @pc/supervisor. No second respawn loop,
// no in-process API import, no one-shot host spawn may come back.
//
// The gate scans app/package SOURCE (not tests, not docs) and fails on:
//   (a) the retired dev-supervisor files existing at all,
//   (b) any banned-resurrection symbol from the deleted paths
//       (`startInProcessServer`, `spawnPackagedAgentHostProcess`, …),
//   (c) any file other than @pc/supervisor's own source constructing a
//       respawn primitive (`new SupervisedChild(`) — children are declared in
//       the ONE child list in apps/desktop/src/main.ts (allowlisted).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
// .../packages/supervisor/test/one-supervisor-gate.test.ts -> repo root
const repoRoot = join(here, '..', '..', '..', '..');

// (a) the retired second supervisor — its files must stay dead.
const RETIRED_FILES = [
  'apps/server/scripts/dev-supervisor.mjs',
  'apps/server/scripts/dev-supervisor-processes.mjs',
];

// (b) symbols of the deleted one-shot/in-process paths. Reintroducing any of
// them anywhere in source FAILS the gate.
const BANNED_SYMBOLS = [
  'startInProcessServer', // packaged in-process API import (API crash killed the window)
  'bootPackagedServerWithGuard', // its boot wrapper
  'spawnPackagedAgentHostProcess', // one-shot host spawn with no respawn
  'buildPackagedAgentHostSpawnSpec',
  'waitForPackagedAgentHostLock', // superseded by @pc/supervisor waitForFreshFile
];
const BANNED_RE = new RegExp(String.raw`\b(${BANNED_SYMBOLS.join('|')})\b`);

// (c) who may construct supervision primitives.
const CONSTRUCT_RE = /\bnew\s+(SupervisedChild|Supervisor)\s*\(/;
const CONSTRUCT_ALLOWLIST = new Set([
  // @pc/supervisor's own source + the ONE child list:
  'packages/supervisor/src/supervisor.ts',
  'apps/desktop/src/main.ts',
]);

const SCAN_ROOTS = ['apps', 'packages', 'scripts', 'templates'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', '.dev-logs', 'release', 'staging', 'data']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js']);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* walk(full);
    } else if (EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
      yield full;
    }
  }
}

function rel(path: string): string {
  return relative(repoRoot, path).split(sep).join('/');
}

/** Strip // and /* *\/ comments so ☠ tombstones may keep naming the dead
 *  (process rule: demolition maps stay in the code) without tripping the gate.
 *  Heuristic, not a parser — good enough for symbol-name matching. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

test('the retired dev-supervisor files stay deleted', () => {
  for (const file of RETIRED_FILES) {
    assert.equal(
      existsSync(join(repoRoot, file)),
      false,
      `${file} exists — the second supervisor must stay retired (ONE-SUPERVISOR)`,
    );
  }
});

test('no banned resurrection symbols and no rogue supervision constructors', () => {
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(repoRoot, root))) {
      const path = rel(file);
      if (path.includes('.test.')) continue;
      const source = stripComments(readFileSync(file, 'utf8'));

      const banned = source.match(BANNED_RE);
      if (banned) offenders.push(`${path}: banned symbol "${banned[1]}"`);

      if (CONSTRUCT_RE.test(source) && !CONSTRUCT_ALLOWLIST.has(path)) {
        offenders.push(`${path}: constructs a supervision primitive outside the one child list`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `ONE-SUPERVISOR violations:\n${offenders.join('\n')}`,
  );
});

test('the one child list lives in Electron main and declares both children', () => {
  const main = readFileSync(join(repoRoot, 'apps/desktop/src/main.ts'), 'utf8');
  assert.match(main, /new\s+Supervisor\s*\(/, 'Electron main builds THE Supervisor');
  assert.match(main, /name:\s*'api'/, 'api child declared');
  assert.match(main, /name:\s*'agent-host'/, 'agent-host child declared');
  assert.match(main, /sentinelRestartCode:\s*75/, 'api child keeps the exit-75 restart sentinel');
});
