// Step 3 — ONE-ROOT gate. The trunk root is derived in exactly one place
// (src/server-root.ts). A second import.meta.url hop-count is a landmine: the
// dev/test runtime executes from `src/` while the bundled runtime executes from
// `dist/`, so any hop-count tuned to a nested src file resolves one level too
// high in the bundle. Live incident: claude-runtime-bundle.ts used four hops →
// every dev agent dispatch failed pod materialisation
// ("scandir <trunk-parent>\templates\.claude\hooks").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const ALLOWED = new Set(['server-root.ts']);

function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (name.endsWith('.ts')) yield p;
  }
}

test('ONE-ROOT: only server-root.ts derives a path from import.meta.url hops', () => {
  // Module-dir + parent-hops in one statement = a root derivation. Multiline-aware.
  const pattern = /import\.meta\.url[\s\S]{0,200}?(?:'\.\.'\s*,\s*){1,}'\.\.'/;
  const offenders: string[] = [];
  for (const file of tsFiles(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, '/');
    if (ALLOWED.has(rel)) continue;
    if (pattern.test(readFileSync(file, 'utf8'))) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `root must come from server-root.ts (SERVER_ROOT), not a local import.meta.url hop-count: ${offenders.join(', ')}`,
  );
});
