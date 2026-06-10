import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { defaultGlobalSettings } from '@pc/domain';
import { getDataDir } from '@pc/utils';
import { getDb, getRawDb } from './connection.ts';
import * as schema from './schema.ts';
import { settingsGlobal } from './schema.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Apply pending migrations, then ensure the settings_global singleton row exists.
 *
 *  `migrationsFolder` defaults to the package-relative `drizzle/` dir (dev/tsx).
 *  In a packaged/bundled build `__dirname` points inside the bundle, so the
 *  server passes an explicit ROOT-relative path to the staged copy. */
export function runMigrations(migrationsFolder = join(__dirname, '..', 'drizzle')): void {
  const db = getDb();
  migrate(db, { migrationsFolder });
  reconcileSkippedMigrations(migrationsFolder);
  assertSchemaIntact();
  seedGlobalSettings();
}

/** Apply journal entries drizzle's watermark skipped (the v0.6.0 crash-loop).
 *
 *  drizzle's migrator applies "entries whose `when` exceeds the LAST applied
 *  row's created_at" — a single watermark, not per-entry presence. A journal
 *  whose `when` values are not strictly increasing (0054 < 0053) makes the
 *  out-of-order entry invisible to every DB already at the watermark: it is
 *  silently skipped, and the app crash-loops at assertSchemaIntact() with no
 *  user-side remedy. Reconcile by IDENTITY instead: a journal entry is applied
 *  iff a ledger row with created_at == entry.when exists; anything missing is
 *  applied here and recorded, turning the crash-loop into self-repair on the
 *  next boot. (Content hash is NOT the key — applied migration files have
 *  been edited after application in this repo, so hashes legitimately drift.) */
function reconcileSkippedMigrations(migrationsFolder: string): void {
  const raw = getRawDb();
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ when: number; tag: string }> };
  // Ledger exists: migrate() above creates it before we get here.
  const applied = new Set(
    (raw.prepare('SELECT created_at FROM __drizzle_migrations').all() as {
      created_at: number | string;
    }[]).map((r) => Number(r.created_at)),
  );
  for (const entry of journal.entries) {
    if (applied.has(entry.when)) continue;
    const content = readFileSync(join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
    raw.transaction(() => {
      for (const statement of content.split('--> statement-breakpoint')) {
        const sql = statement.trim();
        if (sql) raw.exec(sql);
      }
      raw
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        .run(createHash('sha256').update(content).digest('hex'), entry.when);
    })();
    console.warn(`[pc][db] reconciled skipped migration ${entry.tag} (when=${entry.when})`);
  }
}

/** Fail fast on migration-ledger drift. drizzle decides what to apply by the
 *  last-applied timestamp in `__drizzle_migrations`, NOT by inspecting the
 *  schema — so a ledger that records a migration as applied while its columns
 *  are absent silently skips the real ALTER, and the code crashes later with an
 *  opaque `no such column`. After migrate(), assert every column the drizzle
 *  schema declares actually exists in the DB. Source of truth is `schema.ts`
 *  (the meta snapshots are stale — migrations 0015+ are hand-authored). */
export function assertSchemaIntact(): void {
  const raw = getRawDb();
  const drift: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const tableName = getTableName(value);
    const info = raw.pragma(`table_info("${tableName}")`) as { name: string }[];
    if (info.length === 0) {
      drift.push(`missing table "${tableName}"`);
      continue;
    }
    const actual = new Set(info.map((c) => c.name));
    for (const column of Object.values(getTableColumns(value))) {
      if (!actual.has(column.name)) drift.push(`${tableName}.${column.name}`);
    }
  }
  if (drift.length > 0) {
    throw new Error(
      `DB schema is behind the code — ${drift.length} missing table/column(s): [${drift.join(', ')}]. ` +
        `The migration ledger records migrations as applied whose schema is absent, so runMigrations() skipped them. ` +
        `Repair the DB (apply the missing migrations' ALTERs by hand) or reset it. ` +
        `See docs/project-tracker.md "DB migration ledger drift".`,
    );
  }
}

function seedGlobalSettings(): void {
  const db = getDb();
  const existing = db.select().from(settingsGlobal).limit(1).get();
  if (existing) return;
  db.insert(settingsGlobal)
    .values({
      id: 'global',
      values: defaultGlobalSettings(getDataDir(), homedir()),
      updatedAt: Date.now(),
    })
    .run();
}
