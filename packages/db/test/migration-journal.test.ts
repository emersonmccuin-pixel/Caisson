// Migration-ledger drift guards (the v0.6.0 crash-loop).
//
// drizzle applies migrations by a single watermark — "entries whose `when`
// exceeds the last applied row's created_at" — so a journal whose `when`
// values are not strictly increasing makes the out-of-order entry invisible
// to every already-migrated DB. 0054 (when ≈ real Jun 2026) landed BELOW
// 0053's hand-synthesized future `when` (≈ Jul 2026) and was skipped on every
// upgrading install, crash-looping the packaged app at assertSchemaIntact().
//
// Two layers: (1) the journal must stay strictly increasing so the poison is
// never authored again — new entries must use a `when` ABOVE the current max,
// not Date.now(); (2) runMigrations() reconciles skipped entries by identity
// (created_at == when) so an already-poisoned DB self-repairs on next boot.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-migration-journal-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, getRawDb, runMigrations } = await import('../src/index.ts');

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const journal = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'drizzle', 'meta', '_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; when: number; tag: string }> };

// 0054 predates this guard; runtime reconciliation covers it. Never grow this list.
const KNOWN_OUT_OF_ORDER = new Set(['0054_agent_mcp_attachments']);

test('journal `when` values are strictly increasing (watermark-skip guard)', () => {
  let max = { when: -Infinity, tag: '(none)' };
  for (const entry of journal.entries) {
    if (KNOWN_OUT_OF_ORDER.has(entry.tag)) continue;
    assert.ok(
      entry.when > max.when,
      `journal entry ${entry.tag} has when=${entry.when} <= ${max.tag}'s ${max.when}. ` +
        `drizzle's watermark will silently skip it on every already-migrated DB. ` +
        `Set its "when" ABOVE the journal's current max (do NOT trust drizzle-kit's Date.now() — ` +
        `earlier hand-synthesized entries carry future timestamps).`,
    );
    max = { when: entry.when, tag: entry.tag };
  }
});

test('journal `when` values are unique (reconciliation identity key)', () => {
  const seen = new Set<number>();
  for (const entry of journal.entries) {
    assert.ok(!seen.has(entry.when), `duplicate when=${entry.when} (${entry.tag})`);
    seen.add(entry.when);
  }
});

test('runMigrations self-repairs a watermark-skipped migration', () => {
  runMigrations();
  const raw = getRawDb();
  const entry = journal.entries.find((e) => e.tag === '0054_agent_mcp_attachments');
  assert.ok(entry, 'fixture migration 0054 vanished from the journal');

  // Simulate the v0.6.0 field state: schema effects absent, ledger row absent,
  // watermark (a LATER created_at) already present so drizzle's own migrate()
  // will not re-apply it.
  raw.exec('DROP TABLE agent_mcp_attachments');
  raw.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(entry.when);
  const watermark = raw
    .prepare('SELECT MAX(CAST(created_at AS INTEGER)) AS w FROM __drizzle_migrations')
    .get() as { w: number };
  assert.ok(watermark.w > entry.when, 'fixture invalid: 0054 is no longer below the watermark');

  runMigrations();

  const table = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_mcp_attachments'")
    .get();
  assert.ok(table, 'reconciliation did not recreate the skipped table');
  const ledger = raw
    .prepare('SELECT hash FROM __drizzle_migrations WHERE created_at = ?')
    .get(entry.when);
  assert.ok(ledger, 'reconciliation did not record the skipped migration in the ledger');
});
