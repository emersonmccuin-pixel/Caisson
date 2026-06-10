// Slice 1 (Areas + context model) — context_docs migration + repo + FTS5.
//
// Covers:
//  - Migration 0049 creates context_docs table with every schema.ts column
//  - CHECK constraint rejects 0-scope and 2-scope inserts
//  - FTS5 compile guard (ENABLE_FTS5=1)
//  - INSERT/UPDATE/DELETE FTS5 round-trip (hit and miss after each mutation)
//  - CRUD (create, get, update, soft-delete)
//  - listContextDocsForScope
//  - listContextChainDocs: chain order, soft-delete exclusion, area resolution
//  - searchContextDocs: ranked hits, area filter, malformed-query safety

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-ctx-docs-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  assertSchemaIntact,
  closeDb,
  createAgent,
  createArea,
  createContextDoc,
  createProject,
  createWorkItem,
  getAgentContextDocByTitle,
  getContextDoc,
  getRawDb,
  listAgentAudit,
  listContextChainDocs,
  listContextDocsForScope,
  runMigrations,
  sanitizeFts5Query,
  searchContextDocs,
  softDeleteContextDoc,
  updateContextDoc,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

function seedProject(slug: string) {
  return createProject({ slug, name: slug, stages, folderPath: '' });
}

// ── Migration / schema ────────────────────────────────────────────────────────

test('0049 creates context_docs with every schema.ts column', () => {
  const raw = getRawDb();
  const cols = (raw.pragma('table_info("context_docs")') as { name: string }[]).map((c) => c.name);
  for (const col of [
    'id', 'project_id', 'area_id', 'work_item_id',
    'title', 'body', 'author', 'created_at', 'updated_at', 'deleted_at',
  ]) {
    assert.ok(cols.includes(col), `context_docs.${col} should exist`);
  }
});

test('assertSchemaIntact passes after 0049', () => {
  assert.doesNotThrow(() => assertSchemaIntact());
});

test('CHECK rejects 0-scope insert (no pointer set)', () => {
  const raw = getRawDb();
  assert.throws(
    () =>
      raw.prepare(
        `INSERT INTO context_docs (id, title, body, author, created_at, updated_at)
         VALUES ('ZZZZZZZZZZZZZZZZZZZZZZZZZZ', 'T', '', 'user', 1, 1)`,
      ).run(),
    /CHECK constraint failed/i,
  );
});

test('CHECK rejects 2-scope insert (two pointers set)', () => {
  const raw = getRawDb();
  const p = seedProject('p-check2scope');
  assert.throws(
    () =>
      raw.prepare(
        `INSERT INTO context_docs (id, project_id, area_id, title, body, author, created_at, updated_at)
         VALUES ('YYYYYYYYYYYYYYYYYYYYYYYYYYY', ?, ?, 'T', '', 'user', 1, 1)`,
      ).run(p.id, p.id),
    /CHECK constraint failed/i,
  );
});

// ── FTS5 ──────────────────────────────────────────────────────────────────────

test('FTS5 is compiled in (ENABLE_FTS5=1)', () => {
  const raw = getRawDb();
  const row = raw.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS v").get() as { v: number };
  assert.equal(row.v, 1, 'ENABLE_FTS5 must be 1');
});

test('FTS5 INSERT round-trip: inserted doc is findable', () => {
  const p = seedProject('p-fts-insert');
  const doc = createContextDoc({ scope: { projectId: p.id }, title: 'UniqueTermXYZ', body: 'body content here' });
  const results = searchContextDocs({ projectId: p.id, query: 'UniqueTermXYZ' });
  assert.ok(results.some((r) => r.id === doc.id), 'inserted doc should be found by FTS');
});

test('FTS5 UPDATE round-trip: old term misses, new term hits', () => {
  const p = seedProject('p-fts-update');
  const doc = createContextDoc({ scope: { projectId: p.id }, title: 'OldTitleTerm', body: '' });

  // Old term hits.
  assert.ok(searchContextDocs({ projectId: p.id, query: 'OldTitleTerm' }).some((r) => r.id === doc.id));

  // Update title.
  updateContextDoc(doc.id, { title: 'NewTitleTerm' });

  // Old term should no longer hit.
  assert.ok(!searchContextDocs({ projectId: p.id, query: 'OldTitleTerm' }).some((r) => r.id === doc.id));
  // New term should hit.
  assert.ok(searchContextDocs({ projectId: p.id, query: 'NewTitleTerm' }).some((r) => r.id === doc.id));
});

test('FTS5 soft-delete: doc excluded from search after soft-delete', () => {
  const p = seedProject('p-fts-softdelete');
  const doc = createContextDoc({ scope: { projectId: p.id }, title: 'SoftDeleteTerm', body: '' });
  assert.ok(searchContextDocs({ projectId: p.id, query: 'SoftDeleteTerm' }).some((r) => r.id === doc.id));

  softDeleteContextDoc(doc.id);
  // After soft-delete the JOIN filters deleted_at IS NULL.
  assert.ok(!searchContextDocs({ projectId: p.id, query: 'SoftDeleteTerm' }).some((r) => r.id === doc.id));
});

// ── CRUD ──────────────────────────────────────────────────────────────────────

test('createContextDoc enforces exactly-one-scope in app code', () => {
  assert.throws(
    () => createContextDoc({ scope: {} as never, title: 'X' }),
    /scope must have exactly one non-null pointer/,
  );
});

test('createContextDoc and getContextDoc round-trip', () => {
  const p = seedProject('p-crud-ctx');
  const doc = createContextDoc({
    scope: { projectId: p.id },
    title: 'My doc',
    body: 'Hello world',
    author: 'orchestrator',
  });
  assert.equal(doc.projectId, p.id);
  assert.equal(doc.title, 'My doc');
  assert.equal(doc.body, 'Hello world');
  assert.equal(doc.author, 'orchestrator');
  assert.equal(doc.deletedAt, null);

  const fetched = getContextDoc(doc.id);
  assert.ok(fetched);
  assert.equal(fetched!.id, doc.id);
});

test('updateContextDoc bumps updatedAt and returns new row', () => {
  const p = seedProject('p-update-ctx');
  const doc = createContextDoc({ scope: { projectId: p.id }, title: 'Before', body: 'old' });
  const updated = updateContextDoc(doc.id, { title: 'After', body: 'new' });
  assert.ok(updated);
  assert.equal(updated!.title, 'After');
  assert.equal(updated!.body, 'new');
  assert.ok(updated!.updatedAt >= doc.updatedAt);
});

test('softDeleteContextDoc excludes doc from getContextDoc', () => {
  const p = seedProject('p-del-ctx');
  const doc = createContextDoc({ scope: { projectId: p.id }, title: 'Gone', body: '' });
  softDeleteContextDoc(doc.id);
  assert.equal(getContextDoc(doc.id), null);
});

// ── listContextDocsForScope ────────────────────────────────────────────────────

test('listContextDocsForScope returns only docs for that scope', () => {
  const p = seedProject('p-list-scope');
  const area = createArea({ projectId: p.id, name: 'Area' });
  const docP = createContextDoc({ scope: { projectId: p.id }, title: 'Proj doc', body: '' });
  const docA = createContextDoc({ scope: { areaId: area.id }, title: 'Area doc', body: '' });

  const projDocs = listContextDocsForScope({ scope: { projectId: p.id } });
  assert.ok(projDocs.some((d) => d.id === docP.id));
  assert.ok(!projDocs.some((d) => d.id === docA.id));

  const areaDocs = listContextDocsForScope({ scope: { areaId: area.id } });
  assert.ok(areaDocs.some((d) => d.id === docA.id));
  assert.ok(!areaDocs.some((d) => d.id === docP.id));
});

// ── listContextChainDocs ───────────────────────────────────────────────────────

test('listContextChainDocs returns docs in closest-scope-first order', () => {
  const p = seedProject('p-chain');
  const area = createArea({ projectId: p.id, name: 'Backend' });

  // Hierarchy: grandparent → parent → leaf (all in the area)
  const grandparent = createWorkItem({ projectId: p.id, stageId: 'todo', title: 'GP', areaId: area.id });
  const parent = createWorkItem({ projectId: p.id, stageId: 'todo', title: 'P', parentId: grandparent.id, areaId: area.id });
  const leaf = createWorkItem({ projectId: p.id, stageId: 'todo', title: 'L', parentId: parent.id, areaId: area.id });

  const docLeaf = createContextDoc({ scope: { workItemId: leaf.id }, title: 'Leaf doc', body: '' });
  const docParent = createContextDoc({ scope: { workItemId: parent.id }, title: 'Parent doc', body: '' });
  const docArea = createContextDoc({ scope: { areaId: area.id }, title: 'Area doc', body: '' });
  const docProject = createContextDoc({ scope: { projectId: p.id }, title: 'Project doc', body: '' });

  const chain = listContextChainDocs({ workItemId: leaf.id, projectId: p.id });

  const ids = chain.map((d) => d.id);
  // Leaf doc should come before parent, area, project.
  assert.ok(ids.indexOf(docLeaf.id) < ids.indexOf(docParent.id), 'leaf before parent');
  assert.ok(ids.indexOf(docParent.id) < ids.indexOf(docArea.id), 'parent before area');
  assert.ok(ids.indexOf(docArea.id) < ids.indexOf(docProject.id), 'area before project');

  // distanceRank checks.
  const leafEntry = chain.find((d) => d.id === docLeaf.id)!;
  const parentEntry = chain.find((d) => d.id === docParent.id)!;
  assert.equal(leafEntry.distanceRank, 0);
  assert.equal(parentEntry.distanceRank, 1);
  assert.equal(chain.find((d) => d.id === docArea.id)!.scopeKind, 'area');
  assert.equal(chain.find((d) => d.id === docProject.id)!.scopeKind, 'project');
});

test('listContextChainDocs excludes soft-deleted docs', () => {
  const p = seedProject('p-chain-del');
  const wi = createWorkItem({ projectId: p.id, stageId: 'todo', title: 'WI' });
  const doc = createContextDoc({ scope: { workItemId: wi.id }, title: 'Gone', body: '' });
  softDeleteContextDoc(doc.id);

  const chain = listContextChainDocs({ workItemId: wi.id, projectId: p.id });
  assert.ok(!chain.some((d) => d.id === doc.id));
});

// ── Agent scope (migration 0055 — merged agent_knowledge) ─────────────────────

test('agent-scoped CRUD round-trips and lists by agent', () => {
  const agent = createAgent(
    { name: 'pod-ctx-crud', scope: 'global' },
    { actor: 'user' },
  );
  const doc = createContextDoc({
    scope: { agentId: agent.id },
    title: 'Voice rules',
    body: 'Always terse.',
  });
  assert.equal(doc.agentId, agent.id);
  assert.equal(doc.projectId, null);

  const listed = listContextDocsForScope({ scope: { agentId: agent.id } });
  assert.ok(listed.some((d) => d.id === doc.id));

  const fetched = getContextDoc(doc.id);
  assert.equal(fetched!.agentId, agent.id);
});

test('agent-scoped mutations emit context-doc audit rows', () => {
  const agent = createAgent(
    { name: 'pod-ctx-audit', scope: 'global' },
    { actor: 'user' },
  );
  const doc = createContextDoc(
    { scope: { agentId: agent.id }, title: 'Audited', body: 'v1' },
    { actor: 'orchestrator', reason: 'seed' },
  );
  updateContextDoc(doc.id, { body: 'v2' }, { actor: 'user', reason: 'edit' });
  softDeleteContextDoc(doc.id, { actor: 'user', reason: 'prune' });

  const audit = listAgentAudit({ agentId: agent.id, field: 'context-doc' });
  const forDoc = audit.filter((a) => a.fieldRef === doc.id);
  assert.equal(forDoc.length, 3, 'create + update + delete should each audit');
  // Newest-first: delete carries prior only; create carries new only.
  assert.equal(forDoc[0]!.newValue, null);
  assert.match(forDoc[1]!.newValue ?? '', /v2/);
  assert.match(forDoc[2]!.newValue ?? '', /v1/);
  assert.equal(forDoc[2]!.priorValue, null);
});

test('non-agent scopes emit no agent audit', () => {
  const p = seedProject('p-no-audit');
  const agent = createAgent(
    { name: 'pod-ctx-noaudit', scope: 'global' },
    { actor: 'user' },
  );
  const before = listAgentAudit({ agentId: agent.id, field: 'context-doc' }).length;
  createContextDoc({ scope: { projectId: p.id }, title: 'Project doc', body: '' });
  const after = listAgentAudit({ agentId: agent.id, field: 'context-doc' }).length;
  assert.equal(after, before);
});

test('getAgentContextDocByTitle finds live docs only', () => {
  const agent = createAgent(
    { name: 'pod-ctx-title', scope: 'global' },
    { actor: 'user' },
  );
  const doc = createContextDoc({
    scope: { agentId: agent.id },
    title: 'Seeded doc',
    body: 'x',
  });
  assert.equal(getAgentContextDocByTitle({ agentId: agent.id, title: 'Seeded doc' })?.id, doc.id);
  assert.equal(getAgentContextDocByTitle({ agentId: agent.id, title: 'Missing' }), null);

  softDeleteContextDoc(doc.id);
  assert.equal(getAgentContextDocByTitle({ agentId: agent.id, title: 'Seeded doc' }), null);
});

// ── searchContextDocs ─────────────────────────────────────────────────────────

test('searchContextDocs returns ranked hits and area filter narrows results', () => {
  const p = seedProject('p-search');
  const areaA = createArea({ projectId: p.id, name: 'Alpha' });
  const areaB = createArea({ projectId: p.id, name: 'Beta' });

  const docA = createContextDoc({ scope: { areaId: areaA.id }, title: 'SearchableTerm doc A', body: '' });
  const docB = createContextDoc({ scope: { areaId: areaB.id }, title: 'SearchableTerm doc B', body: '' });

  // Both should hit without area filter.
  const all = searchContextDocs({ projectId: p.id, query: 'SearchableTerm' });
  assert.ok(all.some((r) => r.id === docA.id));
  assert.ok(all.some((r) => r.id === docB.id));

  // Area filter should narrow to just docA.
  const filtered = searchContextDocs({ projectId: p.id, query: 'SearchableTerm', areaId: areaA.id });
  assert.ok(filtered.some((r) => r.id === docA.id));
  assert.ok(!filtered.some((r) => r.id === docB.id));
});

test('searchContextDocs: malformed queries are handled without throwing', () => {
  const p = seedProject('p-search-bad');
  // These would normally throw in raw FTS5.
  assert.doesNotThrow(() => searchContextDocs({ projectId: p.id, query: '"unbalanced' }));
  assert.doesNotThrow(() => searchContextDocs({ projectId: p.id, query: 'OR AND NOT' }));
  assert.doesNotThrow(() => searchContextDocs({ projectId: p.id, query: '' }));
});

// ── sanitizeFts5Query unit tests ───────────────────────────────────────────────

test('sanitizeFts5Query wraps each token in double quotes', () => {
  assert.equal(sanitizeFts5Query('hello world'), '"hello" "world"');
  assert.equal(sanitizeFts5Query('  foo  bar  '), '"foo" "bar"');
  assert.equal(sanitizeFts5Query(''), '');
  assert.equal(sanitizeFts5Query('   '), '');
});

test('sanitizeFts5Query strips embedded double quotes from tokens', () => {
  assert.equal(sanitizeFts5Query('"hello"'), '"hello"');
  assert.equal(sanitizeFts5Query('he"llo'), '"hello"');
});
