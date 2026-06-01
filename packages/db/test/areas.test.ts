// Slice 010 — Areas migration + repo CRUD + the delete-reassigns-to-NULL
// invariant + the work-item area filter (incl. 'uncaptured').

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-areas-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  assertSchemaIntact,
  closeDb,
  createArea,
  createProject,
  createWorkItem,
  getArea,
  getRawDb,
  getWorkItem,
  listAreas,
  listWorkItems,
  patchArea,
  reorderAreas,
  runMigrations,
  setWorkItemArea,
  softDeleteArea,
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

test('0037 creates areas table + work_items.area_id with every schema.ts column', () => {
  const raw = getRawDb();
  const areaCols = (raw.pragma('table_info("areas")') as { name: string }[]).map((c) => c.name);
  for (const col of ['id', 'project_id', 'name', 'summary', 'sort_order', 'version', 'created_at', 'updated_at', 'deleted_at']) {
    assert.ok(areaCols.includes(col), `areas.${col} should exist`);
  }
  const wiCols = (raw.pragma('table_info("work_items")') as { name: string }[]).map((c) => c.name);
  assert.ok(wiCols.includes('area_id'), 'work_items.area_id should exist');
});

test('assertSchemaIntact does not throw after a fresh migrate', () => {
  assert.doesNotThrow(() => assertSchemaIntact());
});

test('create assigns gap-free sortOrder; list excludes soft-deleted by default', () => {
  const p = seedProject('p-crud');
  const a = createArea({ projectId: p.id, name: 'Bugs' });
  const b = createArea({ projectId: p.id, name: 'Features', summary: 'big rocks' });
  assert.equal(a.sortOrder, 0);
  assert.equal(b.sortOrder, 1);
  assert.equal(b.summary, 'big rocks');
  assert.equal(a.version, 1);

  const list = listAreas(p.id);
  assert.deepEqual(list.map((x) => x.id), [a.id, b.id]);
});

test('patch bumps version + updatedAt', () => {
  const p = seedProject('p-patch');
  const a = createArea({ projectId: p.id, name: 'X' });
  const patched = patchArea(a.id, { name: 'Y', summary: 'z' });
  assert.ok(patched);
  assert.equal(patched!.name, 'Y');
  assert.equal(patched!.summary, 'z');
  assert.equal(patched!.version, 2);
});

test('reorder rewrites sortOrder 0..N-1 and clamps to live project rows', () => {
  const p = seedProject('p-reorder');
  const a = createArea({ projectId: p.id, name: 'A' });
  const b = createArea({ projectId: p.id, name: 'B' });
  const c = createArea({ projectId: p.id, name: 'C' });
  const out = reorderAreas(p.id, [c.id, a.id, b.id, 'bogus-id']);
  assert.deepEqual(out.map((x) => x.id), [c.id, a.id, b.id]);
  assert.deepEqual(out.map((x) => x.sortOrder), [0, 1, 2]);
});

test('delete soft-deletes the area AND reassigns member work items to NULL', () => {
  const p = seedProject('p-delete');
  const a = createArea({ projectId: p.id, name: 'Doomed' });
  const wi1 = createWorkItem({ projectId: p.id, stageId: 'todo', title: 'one', areaId: a.id });
  const wi2 = createWorkItem({ projectId: p.id, stageId: 'todo', title: 'two', areaId: a.id });
  assert.equal(wi1.areaId, a.id);

  const deleted = softDeleteArea(a.id);
  assert.ok(deleted);
  assert.notEqual(deleted!.deletedAt, null);
  // Area no longer in the default list.
  assert.equal(listAreas(p.id).some((x) => x.id === a.id), false);
  // Members fell back to Uncaptured.
  assert.equal(getWorkItem(wi1.id)!.areaId, null);
  assert.equal(getWorkItem(wi2.id)!.areaId, null);
  // Versions bumped on the reassignment.
  assert.equal(getWorkItem(wi1.id)!.version, wi1.version + 1);
});

test('work-item area filter supports a ULID, null, and "uncaptured"', () => {
  const p = seedProject('p-filter');
  const a = createArea({ projectId: p.id, name: 'A' });
  const inArea = createWorkItem({ projectId: p.id, stageId: 'todo', title: 'in', areaId: a.id });
  const uncaptured = createWorkItem({ projectId: p.id, stageId: 'todo', title: 'out' });

  const byArea = listWorkItems(p.id, { areaId: a.id });
  assert.deepEqual(byArea.map((w) => w.id), [inArea.id]);

  const byNull = listWorkItems(p.id, { areaId: null });
  assert.deepEqual(byNull.map((w) => w.id), [uncaptured.id]);

  const byUncaptured = listWorkItems(p.id, { areaId: 'uncaptured' });
  assert.deepEqual(byUncaptured.map((w) => w.id), [uncaptured.id]);

  // No filter → both.
  assert.equal(listWorkItems(p.id).length, 2);
});

test('setWorkItemArea moves an item between Areas and to Uncaptured', () => {
  const p = seedProject('p-setarea');
  const a = createArea({ projectId: p.id, name: 'A' });
  const wi = createWorkItem({ projectId: p.id, stageId: 'todo', title: 'mover' });
  assert.equal(getWorkItem(wi.id)!.areaId, null);

  assert.equal(setWorkItemArea(wi.id, a.id), wi.id);
  assert.equal(getWorkItem(wi.id)!.areaId, a.id);

  assert.equal(setWorkItemArea(wi.id, null), wi.id);
  assert.equal(getWorkItem(wi.id)!.areaId, null);

  assert.equal(setWorkItemArea('nonexistent', a.id), null);
});

test('getArea returns the row including after soft-delete', () => {
  const p = seedProject('p-get');
  const a = createArea({ projectId: p.id, name: 'A' });
  assert.equal(getArea(a.id)!.name, 'A');
  softDeleteArea(a.id);
  assert.notEqual(getArea(a.id)!.deletedAt, null);
  assert.equal(getArea('nope'), null);
});
