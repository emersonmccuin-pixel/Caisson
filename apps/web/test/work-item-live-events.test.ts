// T3.2b — WorkItemDetailModal field-schema + work-item history fold helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { FieldSchemaDto, LiveEvent } from '@pc/contracts';

import {
  latestFieldSchemas,
  workItemHistoryRows,
} from '../src/features/work-items/work-item-live-events.ts';

function schemaEv(cursor: string, schemas: FieldSchemaDto[]): LiveEvent {
  return {
    id: `fs-${cursor}`,
    cursor,
    scope: 'project',
    projectId: 'p1',
    type: 'field-schema.list.changed',
    entity: 'field-schema',
    entityId: 'p1' as never,
    version: null,
    createdAt: 1,
    payload: { reason: 'replaced', schemas } as never,
  };
}

function schema(key: string): FieldSchemaDto {
  return { id: `f-${key}`, projectId: 'p1', key, label: key, type: 'text', required: false, order: 0 };
}

function wiDto(id: string, version: number, updatedAt: number) {
  return {
    id,
    projectId: 'p1',
    parentId: null,
    callsign: null,
    position: 0,
    title: 'T',
    body: 'B',
    stageId: 'todo',
    status: 'pending',
    statusReason: null,
    type: 'task',
    fields: {},
    version,
    createdAt: 1,
    updatedAt,
    deletedAt: null,
    isWorkflowRoot: false,
    areaId: null,
    focusedAt: null,
  };
}

function wiEv(id: string, version: number, updatedAt: number, cursor: string): LiveEvent {
  return {
    id: `wi-${cursor}`,
    cursor,
    scope: 'project',
    projectId: 'p1',
    type: 'work-item.changed',
    entity: 'work-item',
    entityId: id as never,
    version,
    createdAt: 1,
    payload: { reason: 'patched', workItem: wiDto(id, version, updatedAt) } as never,
  };
}

test('latestFieldSchemas picks the highest-cursor frame', () => {
  const out = latestFieldSchemas([
    schemaEv('3', [schema('old')]),
    schemaEv('7', [schema('new')]),
    schemaEv('5', [schema('mid')]),
  ]);
  assert.deepEqual(out?.map((s) => s.key), ['new']);
});

test('latestFieldSchemas returns null when there are no field-schema frames', () => {
  assert.equal(latestFieldSchemas([]), null);
});

test('workItemHistoryRows folds only the matching work-item id', () => {
  const rows = workItemHistoryRows(
    [wiEv('w1', 2, 100, 'c1'), wiEv('w2', 5, 200, 'c2'), wiEv('w1', 3, 300, 'c3')],
    'w1',
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.text), ['updated · v2', 'updated · v3']);
  assert.deepEqual(rows.map((r) => r.ts), [100, 300]);
  assert.ok(rows.every((r) => r.actor === 'edit'));
});

test('workItemHistoryRows is empty when no frame matches the id', () => {
  assert.deepEqual(workItemHistoryRows([wiEv('w2', 1, 1, 'c1')], 'w1'), []);
});
