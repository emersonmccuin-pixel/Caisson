import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-live-events-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject,
  getDb,
  insertLiveEvent,
  runMigrations,
} = await import('@pc/db');
const { registerLiveEventRoutes } = await import('../src/features/live-events/routes.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

async function json<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

test('live event replay route validates query and handles no-cursor high-water', async () => {
  const app = new Hono();
  registerLiveEventRoutes(app);

  let res = await app.request('/api/live-events?after=abc');
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), {
    ok: false,
    error: 'after must be a non-negative integer cursor',
  });

  const event = insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: 'p1',
    version: null,
    payload: { reason: 'created', projectIdChanged: 'p1' },
  });

  res = await app.request('/api/live-events?type=project.changed');
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    events: [],
    nextCursor: event.cursor,
  });
});

test('live event replay route returns project.changed rows after cursor and filters scope', async () => {
  const app = new Hono();
  registerLiveEventRoutes(app);
  const p1 = createProject({
    slug: `route-p1-${Date.now()}`,
    name: 'Route P1',
    stages,
    folderPath: join(tmpDir, 'route-p1'),
  });
  const p2 = createProject({
    slug: `route-p2-${Date.now()}`,
    name: 'Route P2',
    stages,
    folderPath: join(tmpDir, 'route-p2'),
  });
  const after = (await json<{ nextCursor: string | null }>(
    await app.request('/api/live-events'),
  )).nextCursor ?? '0';

  const global = insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: p1.id,
    version: null,
    payload: { reason: 'reordered' },
  });
  const scopedP1 = insertLiveEvent(getDb(), {
    scope: 'project',
    projectId: p1.id,
    type: 'project.changed',
    entity: 'project',
    entityId: p1.id,
    version: null,
    payload: { reason: 'metadata-updated', projectIdChanged: p1.id },
  });
  insertLiveEvent(getDb(), {
    scope: 'project',
    projectId: p2.id,
    type: 'project.changed',
    entity: 'project',
    entityId: p2.id,
    version: null,
    payload: { reason: 'metadata-updated', projectIdChanged: p2.id },
  });

  const res = await app.request(
    `/api/live-events?after=${after}&projectId=${p1.id}&includeGlobal=1&type=project.changed`,
  );
  const body = await json<{ ok: true; events: Array<{ id: string }>; nextCursor: string }>(res);

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.events.map((event) => event.id), [global.id, scopedP1.id]);
  assert.equal(body.nextCursor, scopedP1.cursor);
});

test('replay returns project-scoped agent.run.changed after cursor + excludes other projects', async () => {
  const app = new Hono();
  registerLiveEventRoutes(app);
  const p1 = createProject({
    slug: `ar-p1-${Date.now()}`,
    name: 'AR P1',
    stages,
    folderPath: join(tmpDir, 'ar-p1'),
  });
  const p2 = createProject({
    slug: `ar-p2-${Date.now()}`,
    name: 'AR P2',
    stages,
    folderPath: join(tmpDir, 'ar-p2'),
  });
  const after = (await json<{ nextCursor: string | null }>(
    await app.request('/api/live-events'),
  )).nextCursor ?? '0';

  const runP1 = insertLiveEvent(getDb(), {
    scope: 'project',
    projectId: p1.id,
    type: 'agent.run.changed',
    entity: 'agent-run',
    entityId: 'run-p1',
    version: 2,
    payload: { reason: 'running' },
  });
  insertLiveEvent(getDb(), {
    scope: 'project',
    projectId: p2.id,
    type: 'agent.run.changed',
    entity: 'agent-run',
    entityId: 'run-p2',
    version: 1,
    payload: { reason: 'running' },
  });

  const res = await app.request(
    `/api/live-events?after=${after}&projectId=${p1.id}&type=agent.run.changed`,
  );
  const body = await json<{ ok: true; events: Array<{ id: string; type: string }> }>(res);
  assert.equal(res.status, 200);
  assert.deepEqual(body.events.map((e) => e.id), [runP1.id]);
  assert.equal(body.events[0].type, 'agent.run.changed');
});

test('replay rejects an unsupported live event type with 400', async () => {
  const app = new Hono();
  registerLiveEventRoutes(app);
  const res = await app.request('/api/live-events?type=agent.bogus');
  assert.equal(res.status, 400);
});
