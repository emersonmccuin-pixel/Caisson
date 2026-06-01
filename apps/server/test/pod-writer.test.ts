// Slice 015b-tail — pods migrated onto the relay live-event door.
//
// announcePod / announcePodDeleted write a durable `pod.changed` fact to the
// live outbox in-txn (the relay drains + delivers the canonical frame). A global
// pod emits a GLOBAL row (reaches every project socket); a project pod emits a
// PROJECT row for its owning project. No hand-fanout.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-pod-writer-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createAgent,
  createProject,
  runMigrations,
  listLiveOutboxRowsAfter,
  getLiveEventHighWater,
} = await import('@pc/db');
const { announcePod, announcePodDeleted } = await import('../src/services/pod-writer.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedProject(): ULID {
  return createProject({
    slug: `pod-rw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: 'Pod RW',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: join(tmpDir, `pod-rw-${Math.random().toString(36).slice(2, 7)}`),
  }).id as ULID;
}

const audit = { actor: 'user' as const, reason: 'test' };

test('announcePod writes a GLOBAL pod.changed outbox row for a global pod', () => {
  const pod = createAgent({ name: `g-${Math.random().toString(36).slice(2, 7)}`, scope: 'global' }, audit);
  const cursor = getLiveEventHighWater() ?? '0';

  announcePod(pod.id as ULID, 'created');

  const rows = listLiveOutboxRowsAfter(cursor, 500);
  const row = rows.find((r) => r.entity === 'pod' && r.entityId === pod.id);
  assert.ok(row, 'expected a pod row in the live outbox');
  assert.equal(row?.type, 'pod.changed');
  assert.equal(row?.scope, 'global');
  assert.equal(row?.projectId, null);
  assert.equal(row?.version, null);
  const payload = row?.payload as { change?: string; podId?: string };
  assert.equal(payload.change, 'created');
  assert.equal(payload.podId, pod.id);
});

test('announcePod writes a PROJECT pod.changed outbox row for a project pod', () => {
  const projectId = seedProject();
  const pod = createAgent(
    { name: `p-${Math.random().toString(36).slice(2, 7)}`, scope: 'project', projectId },
    audit,
  );
  const cursor = getLiveEventHighWater() ?? '0';

  announcePod(pod.id as ULID, 'updated');

  const rows = listLiveOutboxRowsAfter(cursor, 500);
  const row = rows.find((r) => r.entity === 'pod' && r.entityId === pod.id);
  assert.ok(row, 'expected a pod row in the live outbox');
  assert.equal(row?.type, 'pod.changed');
  assert.equal(row?.scope, 'project');
  assert.equal(row?.projectId, projectId);
  assert.equal((row?.payload as { change?: string }).change, 'updated');
});

test('announcePodDeleted writes a deleted pod.changed row with the supplied scope', () => {
  const projectId = seedProject();
  const cursor = getLiveEventHighWater() ?? '0';

  announcePodDeleted('gone-pod-id' as ULID, 'gone', 'project', projectId);

  const rows = listLiveOutboxRowsAfter(cursor, 500);
  const row = rows.find((r) => r.entity === 'pod' && r.entityId === 'gone-pod-id');
  assert.ok(row, 'expected a deleted pod row in the live outbox');
  assert.equal(row?.scope, 'project');
  assert.equal(row?.projectId, projectId);
  assert.equal((row?.payload as { change?: string }).change, 'deleted');
});

test('announcePod on a missing (or soft-deleted) row writes no outbox row', () => {
  const cursor = getLiveEventHighWater() ?? '0';
  announcePod('nope-pod-id' as ULID, 'updated');
  assert.equal(listLiveOutboxRowsAfter(cursor, 500).length, 0);
});

test('a rolled-back txn delivers no pod outbox row', async () => {
  const { getDb, insertLiveEvent } = await import('@pc/db');
  const pod = createAgent({ name: `rb-${Math.random().toString(36).slice(2, 7)}`, scope: 'global' }, audit);
  const cursor = getLiveEventHighWater() ?? '0';
  assert.throws(() => {
    getDb().transaction((tx) => {
      insertLiveEvent(tx, {
        scope: 'global',
        projectId: null,
        type: 'pod.changed',
        entity: 'pod',
        entityId: pod.id as ULID,
        version: null,
        payload: { change: 'updated', podId: pod.id },
      });
      throw new Error('rollback');
    });
  });
  assert.equal(listLiveOutboxRowsAfter(cursor, 500).length, 0);
});
