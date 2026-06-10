// Migration 0055 — agent_knowledge merges into context_docs (agent scope).
//
// Replays the REAL journal 0000→0054 on a raw better-sqlite3 handle (same
// split logic as reconcileSkippedMigrations), seeds pre-merge fixtures, applies
// 0055 alone, then asserts the rebuild:
//  - pre-existing context docs survive byte-identical (agent_id NULL)
//  - agent_knowledge rows land as agent-scoped docs, IDS PRESERVED (audit
//    fieldRef continuity), kind='example' folded into the title suffix
//  - agent_knowledge is gone; the new CHECK accepts 1 pointer, rejects 0/2
//  - FTS index covers both copied and migrated rows ('rebuild' worked) and
//    the recreated triggers keep indexing post-migration inserts

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-knowledge-merge-'));
const dbPath = join(tmpDir, 'replay.sqlite');
const drizzleDir = join(import.meta.dirname, '..', 'drizzle');

const journal = JSON.parse(
  readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; when: number; tag: string }> };

const MERGE_TAG = '0055_unify_context_docs';

let db: InstanceType<typeof Database>;

function applyMigration(tag: string): void {
  const content = readFileSync(join(drizzleDir, `${tag}.sql`), 'utf8');
  db.transaction(() => {
    for (const statement of content.split('--> statement-breakpoint')) {
      const sql = statement.trim();
      if (sql) db.exec(sql);
    }
  })();
}

// Fixture ids (26-char ULID-shaped strings).
const AGENT_ID = '01FIXTUREAGENT000000000000';
const KNOW_ID = '01FIXTUREKNOWLEDGE00000000';
const EXAMPLE_ID = '01FIXTUREEXAMPLE0000000000';
const PROJECT_ID = '01FIXTUREPROJECT0000000000';
const PROJ_DOC_ID = '01FIXTUREPROJDOC0000000000';

before(() => {
  db = new Database(dbPath);
  for (const entry of journal.entries) {
    if (entry.tag === MERGE_TAG) break;
    applyMigration(entry.tag);
  }

  // Pre-merge fixtures. better-sqlite3 v12 defaults foreign_keys=ON (same as
  // the prod connection), so agent_knowledge needs a real agents parent row —
  // and 0055 gets exercised under FK enforcement exactly like a live boot.
  db.prepare(
    `INSERT INTO agents (id, name, scope, created_at, updated_at)
     VALUES (?, 'fixture-pod', 'global', 90, 90)`,
  ).run(AGENT_ID);
  db.prepare(
    `INSERT INTO agent_knowledge (id, agent_id, scope, project_id, name, kind, content, created_at, updated_at)
     VALUES (?, ?, 'global', NULL, 'Style guide', 'knowledge', 'MigratedBodyTerm canonical voice rules', 100, 200)`,
  ).run(KNOW_ID, AGENT_ID);
  db.prepare(
    `INSERT INTO agent_knowledge (id, agent_id, scope, project_id, name, kind, content, created_at, updated_at)
     VALUES (?, ?, 'global', NULL, 'Good report', 'example', 'ExampleBodyTerm sample output', 110, 210)`,
  ).run(EXAMPLE_ID, AGENT_ID);
  db.prepare(
    `INSERT INTO context_docs (id, project_id, title, body, author, created_at, updated_at)
     VALUES (?, ?, 'Existing project doc', 'PreexistingBodyTerm stays put', 'orchestrator', 120, 220)`,
  ).run(PROJ_DOC_ID, PROJECT_ID);

  applyMigration(MERGE_TAG);
});

after(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('journal contains 0055 above the watermark max', () => {
  const entry = journal.entries.find((e) => e.tag === MERGE_TAG);
  assert.ok(entry, '0055 missing from journal');
  const maxOther = Math.max(
    ...journal.entries.filter((e) => e.tag !== MERGE_TAG).map((e) => e.when),
  );
  assert.ok(entry!.when > maxOther, `0055 when=${entry!.when} must exceed ${maxOther}`);
});

test('pre-existing context doc survives the rebuild unchanged', () => {
  const row = db
    .prepare('SELECT * FROM context_docs WHERE id = ?')
    .get(PROJ_DOC_ID) as Record<string, unknown>;
  assert.ok(row, 'pre-existing doc vanished');
  assert.equal(row.project_id, PROJECT_ID);
  assert.equal(row.agent_id, null);
  assert.equal(row.title, 'Existing project doc');
  assert.equal(row.body, 'PreexistingBodyTerm stays put');
  assert.equal(row.author, 'orchestrator');
  assert.equal(row.created_at, 120);
  assert.equal(row.updated_at, 220);
});

test('knowledge row migrates with id preserved and agent scope set', () => {
  const row = db
    .prepare('SELECT * FROM context_docs WHERE id = ?')
    .get(KNOW_ID) as Record<string, unknown>;
  assert.ok(row, 'migrated knowledge row missing — id was not preserved');
  assert.equal(row.agent_id, AGENT_ID);
  assert.equal(row.project_id, null);
  assert.equal(row.title, 'Style guide');
  assert.equal(row.body, 'MigratedBodyTerm canonical voice rules');
  assert.equal(row.created_at, 100);
  assert.equal(row.updated_at, 200);
  assert.equal(row.deleted_at, null);
});

test("kind='example' folds into the title suffix", () => {
  const row = db
    .prepare('SELECT title FROM context_docs WHERE id = ?')
    .get(EXAMPLE_ID) as { title: string };
  assert.equal(row.title, 'Good report (example)');
});

test('agent_knowledge table is gone', () => {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_knowledge'")
    .get();
  assert.equal(table, undefined);
});

test('agent index exists on the rebuilt table', () => {
  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='context_docs_agent_idx'")
    .get();
  assert.ok(idx, 'context_docs_agent_idx missing after rebuild');
});

test('CHECK accepts a 1-pointer agent insert, rejects 0 and 2 pointers', () => {
  assert.doesNotThrow(() =>
    db
      .prepare(
        `INSERT INTO context_docs (id, agent_id, title, body, author, created_at, updated_at)
         VALUES ('01CHECKONEPOINTER000000000', ?, 'ok', '', 'user', 1, 1)`,
      )
      .run(AGENT_ID),
  );
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO context_docs (id, title, body, author, created_at, updated_at)
           VALUES ('01CHECKZEROPOINTER00000000', 'bad', '', 'user', 1, 1)`,
        )
        .run(),
    /CHECK constraint failed/i,
  );
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO context_docs (id, agent_id, project_id, title, body, author, created_at, updated_at)
           VALUES ('01CHECKTWOPOINTERS00000000', ?, ?, 'bad', '', 'user', 1, 1)`,
        )
        .run(AGENT_ID, PROJECT_ID),
    /CHECK constraint failed/i,
  );
});

test('FTS rebuild indexed both copied and migrated rows', () => {
  const hit = (term: string): string[] =>
    (
      db
        .prepare(
          `SELECT cd.id FROM context_docs_fts JOIN context_docs cd ON context_docs_fts.rowid = cd.rowid
           WHERE context_docs_fts MATCH ?`,
        )
        .all(`"${term}"`) as { id: string }[]
    ).map((r) => r.id);
  assert.ok(hit('PreexistingBodyTerm').includes(PROJ_DOC_ID), 'copied row not in FTS');
  assert.ok(hit('MigratedBodyTerm').includes(KNOW_ID), 'migrated knowledge row not in FTS');
  assert.ok(hit('ExampleBodyTerm').includes(EXAMPLE_ID), 'migrated example row not in FTS');
});

test('recreated triggers index post-migration inserts', () => {
  db.prepare(
    `INSERT INTO context_docs (id, agent_id, title, body, author, created_at, updated_at)
     VALUES ('01POSTMERGEINSERT000000000', ?, 'Fresh doc', 'PostMergeBodyTerm content', 'user', 1, 1)`,
  ).run(AGENT_ID);
  const rows = db
    .prepare(
      `SELECT cd.id FROM context_docs_fts JOIN context_docs cd ON context_docs_fts.rowid = cd.rowid
       WHERE context_docs_fts MATCH '"PostMergeBodyTerm"'`,
    )
    .all() as { id: string }[];
  assert.ok(rows.some((r) => r.id === '01POSTMERGEINSERT000000000'));
});
