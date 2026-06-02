import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-agent-run-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createPendingAsk,
  createProject,
  getAgentRunRow,
  getPendingAsk,
  insertAgentRunRow,
  listLiveOutboxRowsAfter,
  newId,
  runMigrations,
} = await import('@pc/db');
const { registerAgentRunRoutes } = await import('../src/features/agent-runs/routes.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function mkApp(broadcasts: unknown[]): { app: Hono } {
  const app = new Hono();
  registerAgentRunRoutes(app, {
    broadcastTo: (_projectId, msg) => broadcasts.push(msg),
    // no active-run registry handle -> phantom path
    getActiveRunRegistry: () => ({ get: () => null }),
  });
  return { app };
}

test('reads (/agent-runs) return the legacy shimmed shape and do not emit', async () => {
  const broadcasts: unknown[] = [];
  const { app } = mkApp(broadcasts);
  const project = createProject({
    slug: `arr-read-${Date.now()}`,
    name: 'ARR Read',
    stages,
    folderPath: join(tmpDir, 'arr-read'),
  });
  const runId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'builder',
    dispatcherSessionId: 'disp1',
    ccSessionId: 'cc-1',
    status: 'running',
    input: 'go',
    queuedAt: Date.now(),
  });

  const res = await app.request(`/api/projects/${project.id}/agent-runs`);
  assert.equal(res.status, 200);
  const body = await json<{ ok: true; runs: Array<{ runId: string; wait: boolean; model: string }> }>(res);
  assert.equal(body.ok, true);
  const card = body.runs.find((r) => r.runId === runId);
  assert.ok(card);
  assert.equal(card!.wait, false);
  assert.equal(card!.model, 'opus');
  assert.equal(broadcasts.length, 0);
});

test('phantom-cancel: cancelling a paused run with NO registry handle finalizes the row + writes the live outbox (no legacy broadcast)', async () => {
  const broadcasts: unknown[] = [];
  const { app } = mkApp(broadcasts);
  const project = createProject({
    slug: `arr-cancel-${Date.now()}`,
    name: 'ARR Cancel',
    stages,
    folderPath: join(tmpDir, 'arr-cancel'),
  });
  const runId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'builder',
    dispatcherSessionId: 'disp1',
    ccSessionId: 'cc-2',
    status: 'paused',
    input: 'go',
    queuedAt: Date.now(),
  });
  const askId = newId();
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: 'cc-2',
    projectId: project.id,
    kind: 'orchestrator',
    promptBody: 'q?',
    now: Date.now(),
  });

  const res = await app.request(
    `/api/projects/${project.id}/agent-pending-asks/${askId}/cancel`,
    { method: 'POST' },
  );
  assert.equal(res.status, 200);
  const body = await json<{ ok: true; agentRunId: string }>(res);
  assert.equal(body.agentRunId, runId);

  // Durable finalize even with no registry handle (phantom-safe).
  assert.equal(getAgentRunRow(runId)?.status, 'cancelled');
  assert.equal(getPendingAsk(askId)?.status, 'cancelled');

  // Slice 015b — the durable agent.run.changed fact is written to the live
  // outbox (the relay drains + delivers it); the legacy `agent-run-changed`
  // hand-broadcast is GONE.
  const outboxRows = listLiveOutboxRowsAfter('0', 500);
  assert.ok(
    outboxRows.some(
      (r) =>
        r.entity === 'agent-run' &&
        r.entityId === runId &&
        (r.payload as { run?: { status?: string } } | null)?.run?.status === 'cancelled',
    ),
    'expected a cancelled agent-run row in the live outbox',
  );
  assert.equal(
    broadcasts.filter((b) => (b as { type?: string }).type === 'agent-run-changed').length,
    0,
    'legacy agent-run-changed hand-broadcast must be gone',
  );
});

test('cancel of an unknown pending-ask returns 404 and emits nothing', async () => {
  const broadcasts: unknown[] = [];
  const { app } = mkApp(broadcasts);
  const project = createProject({
    slug: `arr-404-${Date.now()}`,
    name: 'ARR 404',
    stages,
    folderPath: join(tmpDir, 'arr-404'),
  });
  const res = await app.request(
    `/api/projects/${project.id}/agent-pending-asks/${newId()}/cancel`,
    { method: 'POST' },
  );
  assert.equal(res.status, 404);
  assert.equal(broadcasts.length, 0);
});
