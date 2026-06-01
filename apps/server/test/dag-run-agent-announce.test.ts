// Slice 015b — dag-run-service migrated its workflow-subagent `agent-run-changed`
// hand-broadcast (`broadcastRun`) to the durable `announceAgentRunChange` seam,
// so the live-relay delivers the canonical frame (the web no longer reads the
// legacy envelope, and the old hand-broadcast wrote no outbox row).
//
// This pins that seam's contract: announceAgentRunChange writes the durable
// `agent.run.changed` outbox row (entity agent-run, full run snapshot) and does
// NOT emit a legacy `agent-run-changed` hand envelope.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-dag-agent-announce-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject,
  insertAgentRunRow,
  newId,
  runMigrations,
  listLiveOutboxRowsAfter,
  getLiveEventHighWater,
  updateAgentRunStatus,
} = await import('@pc/db');
const { announceAgentRunChange } = await import('../src/services/agent-run-writer.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

test('announceAgentRunChange writes the agent-run outbox fact + no legacy hand envelope', () => {
  const project = createProject({
    slug: `dag-ann-${Date.now()}`,
    name: 'Dag Announce',
    stages,
    folderPath: join(tmpDir, 'dag-ann'),
  });
  const runId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'builder',
    dispatcherSessionId: 'disp1',
    ccSessionId: 'cc-1',
    status: 'queued',
    input: 'go',
    queuedAt: Date.now(),
  });
  updateAgentRunStatus({ id: runId as ULID, status: 'running' });

  const before = getLiveEventHighWater() ?? '0';
  const broadcasts: unknown[] = [];
  announceAgentRunChange({ runId: runId as ULID, reason: 'running' }, (e) => broadcasts.push(e));

  const rows = listLiveOutboxRowsAfter(before, 500);
  const row = rows.find((r) => r.entity === 'agent-run' && r.entityId === runId);
  assert.ok(row, 'expected an agent-run row in the live outbox');
  assert.equal((row?.payload as { run?: { status?: string } } | null)?.run?.status, 'running');

  assert.equal(
    broadcasts.filter((b) => (b as { type?: string }).type === 'agent-run-changed').length,
    0,
    'legacy agent-run-changed hand-broadcast must be gone',
  );
});
