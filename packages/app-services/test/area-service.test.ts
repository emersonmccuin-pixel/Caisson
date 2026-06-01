// Slice 010 — AreaService announces an `area.changed` fact for each mutation,
// atomically with the repo write. Uses a real temp DB (the repo writes need a
// real executor) + a recording insertLiveEvent stub injected into the service.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-area-service-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('@pc/db');
const { AreaService } = await import('../src/areas/index.ts');
const { isAreaChangedLiveEvent } = await import('@pc/contracts');

import type { InsertLiveEventDraft, LiveOutboxEvent } from '@pc/db';

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

/** A service whose insertLiveEvent records drafts (and still inserts into the
 *  real outbox so the row is durable + the event guard sees a real shape). */
function makeService() {
  const drafts: InsertLiveEventDraft[] = [];
  const recordingInsert = (<TPayload>(
    tx: Parameters<typeof db.insertLiveEvent>[0],
    draft: InsertLiveEventDraft<TPayload>,
  ): LiveOutboxEvent<TPayload> => {
    drafts.push(draft as InsertLiveEventDraft);
    return db.insertLiveEvent(tx, draft);
  }) as typeof db.insertLiveEvent;
  const service = new AreaService({ insertLiveEvent: recordingInsert });
  return { service, drafts };
}

function seedProject(slug: string) {
  return db.createProject({ slug, name: slug, stages, folderPath: '' });
}

test('create emits exactly one area.changed (created) fact', () => {
  const p = seedProject('svc-create');
  const { service, drafts } = makeService();
  const area = service.create({ projectId: p.id, name: 'Bugs', summary: 's' });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.type, 'area.changed');
  assert.equal(drafts[0]!.entity, 'area');
  assert.equal(drafts[0]!.scope, 'project');
  assert.equal(drafts[0]!.entityId, area.id);
  assert.equal(drafts[0]!.version, area.version);
  assert.equal((drafts[0]!.payload as { reason: string }).reason, 'created');
  // a durable row landed
  assert.equal(db.listAreas(p.id).length, 1);
});

test('patch emits a patched fact carrying the new version', () => {
  const p = seedProject('svc-patch');
  const { service, drafts } = makeService();
  const area = service.create({ projectId: p.id, name: 'X' });
  const patched = service.patch({ projectId: p.id, id: area.id, name: 'Y' });
  assert.ok(patched);
  assert.equal(drafts.length, 2);
  assert.equal((drafts[1]!.payload as { reason: string }).reason, 'patched');
  assert.equal(drafts[1]!.version, patched!.version);
});

test('reorder emits a reordered fact with the full ordered set (null entityId)', () => {
  const p = seedProject('svc-reorder');
  const { service, drafts } = makeService();
  const a = service.create({ projectId: p.id, name: 'A' });
  const b = service.create({ projectId: p.id, name: 'B' });
  drafts.length = 0;
  const out = service.reorder({ projectId: p.id, orderedIds: [b.id, a.id] });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.entityId, null);
  assert.equal(drafts[0]!.version, null);
  const payload = drafts[0]!.payload as { reason: string; areas: { id: string }[] };
  assert.equal(payload.reason, 'reordered');
  assert.deepEqual(payload.areas.map((x) => x.id), [b.id, a.id]);
  assert.deepEqual(out.map((x) => x.id), [b.id, a.id]);
});

test('delete emits a deleted fact + the row guard accepts the live event', () => {
  const p = seedProject('svc-delete');
  const { service, drafts } = makeService();
  const a = service.create({ projectId: p.id, name: 'Doomed' });
  drafts.length = 0;
  const before = db.getLiveEventHighWater();
  const deleted = service.softDelete({ projectId: p.id, id: a.id });
  assert.ok(deleted);
  assert.equal(drafts.length, 1);
  assert.equal((drafts[0]!.payload as { reason: string }).reason, 'deleted');

  // The durable outbox row deserializes into a valid AreaChangedLiveEvent.
  const after = db.listLiveEventsAfter({ after: before ?? '0', projectId: p.id });
  const areaEvt = after.events.find((e) => e.type === 'area.changed');
  assert.ok(areaEvt);
  assert.equal(isAreaChangedLiveEvent(areaEvt), true);
});

test('a mutation on a missing area emits NOTHING (returns null)', () => {
  const p = seedProject('svc-missing');
  const { service, drafts } = makeService();
  const out = service.patch({ projectId: p.id, id: 'no-such-area', name: 'x' });
  assert.equal(out, null);
  assert.equal(drafts.length, 0);
});
