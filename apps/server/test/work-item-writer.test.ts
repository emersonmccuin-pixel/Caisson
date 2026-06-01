// Slice 015b — work-items + stages migrated to the relay live-event door.
//
// announceWorkItemRow / announceWorkItem write a durable `work-item.changed`
// fact to the live outbox in-txn (the relay drains + delivers the canonical
// frame). announceStageList writes a `stage.list.changed` fact. No hand-fanout.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-wi-writer-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject,
  createWorkItem,
  runMigrations,
  listLiveOutboxRowsAfter,
  getLiveEventHighWater,
  updateProjectStages,
} = await import('@pc/db');
const { announceWorkItem, announceWorkItemRow } = await import(
  '../src/services/work-item-writer.ts'
);
const { announceStageList } = await import('../src/services/stage-writer.ts');
const { FieldSchemaService } = await import('../src/services/field-schema.ts');
const { announceSessionTitle } = await import('../src/services/session-title-writer.ts');
const { createOrchestratorSession, setOrchestratorSessionTitle, getOrchestratorSession } =
  await import('@pc/db');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [
  { id: 'todo', name: 'Todo', order: 0 },
  { id: 'done', name: 'Done', order: 1, isDone: true },
];

function seedProject(): ULID {
  return createProject({
    slug: `wi-rw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: 'WI RW',
    stages,
    folderPath: join(tmpDir, `wi-rw-${Math.random().toString(36).slice(2, 7)}`),
  }).id as ULID;
}

function seedWorkItem(projectId: ULID) {
  return createWorkItem({ projectId, title: 'Do it', stageId: 'todo' });
}

test('announceWorkItemRow writes a project-scoped work-item.changed outbox row', () => {
  const projectId = seedProject();
  const wi = seedWorkItem(projectId);
  const before = getLiveEventHighWater() ?? '0';

  announceWorkItemRow(wi, projectId, 'patched');

  const rows = listLiveOutboxRowsAfter(before, 500);
  const row = rows.find((r) => r.entity === 'work-item' && r.entityId === wi.id);
  assert.ok(row, 'expected a work-item row in the live outbox');
  assert.equal(row?.type, 'work-item.changed');
  assert.equal(row?.scope, 'project');
  assert.equal(row?.projectId, projectId);
  // Per-entity rev = the work item's version counter.
  assert.equal(row?.version, wi.version);
  assert.equal((row?.payload as { reason?: string }).reason, 'patched');
});

test('announceWorkItem on a missing row writes no outbox row', () => {
  const projectId = seedProject();
  const before = getLiveEventHighWater() ?? '0';
  announceWorkItem('nope-work-item-id' as ULID, projectId, 'patched');
  assert.equal(listLiveOutboxRowsAfter(before, 500).length, 0);
});

test('announceStageList writes a stage.list.changed outbox row with the new rev', () => {
  const projectId = seedProject();
  const stamped = updateProjectStages(projectId, [
    { id: 'todo', name: 'Todo', order: 0 },
    { id: 'doing', name: 'Doing', order: 1 },
  ]);
  const before = getLiveEventHighWater() ?? '0';

  announceStageList(projectId, stamped);

  const rows = listLiveOutboxRowsAfter(before, 500);
  const row = rows.find((r) => r.entity === 'stage' && r.projectId === projectId);
  assert.ok(row, 'expected a stage row in the live outbox');
  assert.equal(row?.type, 'stage.list.changed');
  assert.equal(row?.scope, 'project');
  assert.equal(row?.entityId, null);
  const payload = row?.payload as { stagesRev?: number; stages?: unknown[]; reason?: string };
  assert.equal(payload.reason, 'replaced');
  assert.equal(payload.stagesRev, (stamped[0] as { rev?: number }).rev);
  assert.equal(payload.stages?.length, 2);
});

test('FieldSchemaService.replace writes a field-schema.list.changed outbox row', () => {
  const projectId = seedProject();
  const before = getLiveEventHighWater() ?? '0';
  const svc = new FieldSchemaService({ projectId });
  svc.replace([{ key: 'sev', label: 'Severity', type: 'text', required: false, order: 0 }]);

  const rows = listLiveOutboxRowsAfter(before, 500);
  const row = rows.find((r) => r.entity === 'field-schema' && r.projectId === projectId);
  assert.ok(row, 'expected a field-schema row in the live outbox');
  assert.equal(row?.type, 'field-schema.list.changed');
  assert.equal(row?.scope, 'project');
  assert.equal(row?.entityId, null);
  const payload = row?.payload as { schemas?: unknown[]; reason?: string };
  assert.equal(payload.reason, 'replaced');
  assert.equal(payload.schemas?.length, 1);
});

test('announceSessionTitle writes a session.title.changed outbox row', () => {
  const projectId = seedProject();
  const session = createOrchestratorSession({ projectId, providerSessionId: 'prov-1' });
  setOrchestratorSessionTitle(session.id as ULID, 'My chat');
  const updated = getOrchestratorSession(session.id as ULID)!;
  const before = getLiveEventHighWater() ?? '0';

  announceSessionTitle(projectId, updated);

  const rows = listLiveOutboxRowsAfter(before, 500);
  const row = rows.find((r) => r.entity === 'session-title' && r.entityId === session.id);
  assert.ok(row, 'expected a session-title row in the live outbox');
  assert.equal(row?.type, 'session.title.changed');
  assert.equal(row?.scope, 'project');
  assert.equal(row?.projectId, projectId);
  assert.equal((row?.payload as { session?: { title?: string } }).session?.title, 'My chat');
});

test('a rolled-back txn delivers no work-item outbox row', async () => {
  const { getDb, insertLiveEvent } = await import('@pc/db');
  const projectId = seedProject();
  const wi = seedWorkItem(projectId);
  const before = getLiveEventHighWater() ?? '0';
  assert.throws(() => {
    getDb().transaction((tx) => {
      insertLiveEvent(tx, {
        scope: 'project',
        projectId,
        type: 'work-item.changed',
        entity: 'work-item',
        entityId: wi.id,
        version: wi.version,
        payload: { reason: 'patched' },
      });
      throw new Error('rollback');
    });
  });
  assert.equal(listLiveOutboxRowsAfter(before, 500).length, 0);
});
