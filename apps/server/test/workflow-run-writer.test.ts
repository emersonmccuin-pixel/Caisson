// Slice 015b — workflow-runs migrated to the relay live-event frame.
//
// `writeRunStatus` / `announceRun` write the durable `workflow.run.changed` fact
// to the live outbox in-txn (the live-relay drains + delivers the canonical
// frame). The hand `live-event` frame fanout is GONE; the legacy
// `workflow-v2-run-changed` envelope STAYS (retired by 015c) for the drawer /
// other consumers.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-wf-run-writer-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject,
  runMigrations,
  workflowRunsV2Repo,
  listLiveOutboxRowsAfter,
  getLiveEventHighWater,
} = await import('@pc/db');
const { writeRunStatus, announceRun } = await import('../src/services/workflow-run-writer.ts');
const { isWorkflowRunChangedLiveEventFrame } = await import('@pc/contracts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

function seedProject(): ULID {
  return createProject({
    slug: `wf-rw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: 'WF RW',
    stages,
    folderPath: join(tmpDir, `wf-rw-${Math.random().toString(36).slice(2, 7)}`),
  }).id as ULID;
}

function seedRun(projectId: ULID) {
  return workflowRunsV2Repo.createRun({
    workflowId: 'wf-slug',
    workflowName: 'My Flow',
    projectId,
    workflowYamlSnapshot: 'name: My Flow\n',
    trigger: 'manual',
    status: 'running',
  });
}

test('writeRunStatus writes the outbox fact (full run snapshot) + legacy envelope, NO hand frame', () => {
  const projectId = seedProject();
  const run = seedRun(projectId);
  const before = getLiveEventHighWater() ?? '0';

  const broadcasts: unknown[] = [];
  writeRunStatus(run.id as ULID, 'completed', { lastReason: 'done' }, projectId, (e) =>
    broadcasts.push(e),
  );

  // Durable outbox row: entity workflow-run, carries the full run snapshot.
  const rows = listLiveOutboxRowsAfter(before, 500);
  const row = rows.find((r) => r.entity === 'workflow-run' && r.entityId === run.id);
  assert.ok(row, 'expected a workflow-run row in the live outbox');
  assert.equal(
    (row?.payload as { run?: { status?: string } } | null)?.run?.status,
    'completed',
  );

  // No hand `live-event` frame on the broadcast sink (the relay delivers it).
  assert.equal(
    broadcasts.filter((b) => isWorkflowRunChangedLiveEventFrame(b)).length,
    0,
    'hand live-event frame must be gone',
  );
  // Legacy envelope still emitted (retired in 015c).
  assert.ok(
    broadcasts.some((b) => (b as { type?: string }).type === 'workflow-v2-run-changed'),
    'legacy workflow-v2-run-changed envelope still emitted',
  );
});

test('announceRun on a missing run emits nothing and writes no outbox row', () => {
  const before = getLiveEventHighWater() ?? '0';
  const broadcasts: unknown[] = [];
  announceRun('nope-run-id' as ULID, seedProject(), (e) => broadcasts.push(e));
  assert.equal(broadcasts.length, 0);
  assert.equal(listLiveOutboxRowsAfter(before, 500).length, 0);
});
