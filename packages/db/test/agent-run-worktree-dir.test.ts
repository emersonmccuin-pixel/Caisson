// Migration 0048 — agent_runs.worktree_dir column
// Verifies (1) migrate() applies 0048 and (2) assertSchemaIntact() passes.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-worktree-dir-'));
process.env.PC_DATA_DIR = tmpDir;

const { assertSchemaIntact, closeDb, getRawDb, runMigrations } = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('0048 creates agent_runs.worktree_dir column', () => {
  const raw = getRawDb();
  const cols = (raw.pragma('table_info("agent_runs")') as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('worktree_dir'), 'agent_runs.worktree_dir should exist after migration 0048');
});

test('assertSchemaIntact passes after migration 0048', () => {
  assert.doesNotThrow(() => assertSchemaIntact());
});
