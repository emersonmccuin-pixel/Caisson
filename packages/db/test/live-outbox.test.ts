import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-live-outbox-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject,
  getDb,
  getLatestLiveEventForEntity,
  getLiveEventFloor,
  getProjectById,
  insertLiveEvent,
  listLiveEventsAfter,
  listLiveOutboxRowsAfter,
  pruneLiveOutbox,
  runMigrations,
  updateProjectMetaInDb,
  LiveEventCursorError,
} = await import('../src/index.ts');

function insertGlobal(entityId: string, createdAt?: number) {
  return insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId,
    version: null,
    payload: { reason: 'created', projectIdChanged: entityId },
    ...(createdAt !== undefined ? { createdAt } : {}),
  });
}

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

test('live outbox inserts global events and replays by exclusive cursor', () => {
  const first = insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: 'p1',
    version: null,
    payload: { reason: 'created', projectIdChanged: 'p1' },
    createdAt: 1,
  });
  const second = insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: 'p2',
    version: null,
    payload: { reason: 'metadata-updated', projectIdChanged: 'p2' },
    createdAt: 2,
  });

  assert.equal(first.cursor, '1');
  assert.equal(second.cursor, '2');
  assert.deepEqual(listLiveEventsAfter({ after: first.cursor, type: 'project.changed' }), {
    events: [second],
    nextCursor: second.cursor,
  });
});

test('getLatestLiveEventForEntity returns the most-recent row, or null when none', () => {
  // T2.3 cold-load seed source. No host-health rows yet → null.
  assert.equal(getLatestLiveEventForEntity('host-health'), null);

  insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'host-health.changed',
    entity: 'host-health',
    entityId: 'host-health',
    version: null,
    payload: { health: { state: 'reconnecting', since: 1 } },
  });
  const latest = insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'host-health.changed',
    entity: 'host-health',
    entityId: 'host-health',
    version: null,
    payload: { health: { state: 'connected', hostId: 'h1', pid: 42, since: 2 } },
  });

  const got = getLatestLiveEventForEntity('host-health');
  assert.equal(got?.cursor, latest.cursor);
  assert.equal((got?.payload as { health: { state: string } }).health.state, 'connected');
});

test('live replay filters global/project rows and excludes other projects', () => {
  const p1 = createProject({
    slug: `outbox-p1-${Date.now()}`,
    name: 'Outbox P1',
    stages,
    folderPath: join(tmpDir, 'p1'),
  });
  const p2 = createProject({
    slug: `outbox-p2-${Date.now()}`,
    name: 'Outbox P2',
    stages,
    folderPath: join(tmpDir, 'p2'),
  });
  const highWater = listLiveEventsAfter({}).nextCursor ?? '0';

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

  assert.deepEqual(
    listLiveEventsAfter({ after: highWater, projectId: p1.id, includeGlobal: true }).events.map(
      (event) => event.id,
    ),
    [global.id, scopedP1.id],
  );
  assert.deepEqual(
    listLiveEventsAfter({ after: highWater, projectId: p1.id, includeGlobal: false }).events.map(
      (event) => event.id,
    ),
    [scopedP1.id],
  );
  assert.deepEqual(
    listLiveEventsAfter({ after: highWater }).events.map((event) => event.id),
    [global.id],
  );
});

test('no-cursor replay returns no history and advances to high-water', () => {
  const highWater = listLiveEventsAfter({}).nextCursor;
  const replay = listLiveEventsAfter({ limit: 10 });

  assert.deepEqual(replay.events, []);
  assert.equal(replay.nextCursor, highWater);
});

test('live outbox rejects malformed cursors and invalid scope/project combinations', () => {
  assert.throws(
    () => listLiveEventsAfter({ after: 'not-a-cursor' }),
    LiveEventCursorError,
  );
  assert.throws(
    () =>
      insertLiveEvent(getDb(), {
        scope: 'global',
        projectId: 'p1',
        type: 'project.changed',
        entity: 'project',
        entityId: 'p1',
        version: null,
        payload: { reason: 'created' },
      }),
    /global live events must not carry projectId/,
  );
});

test('project mutation and outbox insert roll back together in one transaction', () => {
  const project = createProject({
    slug: `rollback-${Date.now()}`,
    name: 'Rollback Original',
    stages,
    folderPath: join(tmpDir, 'rollback'),
  });
  const after = listLiveEventsAfter({}).nextCursor ?? '0';

  assert.throws(() => {
    getDb().transaction((tx) => {
      updateProjectMetaInDb(tx, project.id, { name: 'Rolled Back' });
      insertLiveEvent(tx, {
        scope: 'global',
        projectId: project.id,
        type: 'project.changed',
        entity: 'project',
        entityId: project.id,
        version: null,
        payload: { reason: 'metadata-updated', projectIdChanged: project.id },
      });
    });
  }, /global live events must not carry projectId/);

  assert.equal(getProjectById(project.id)?.name, 'Rollback Original');
  assert.deepEqual(listLiveEventsAfter({ after }).events, []);
});

// ── Slice 015a — prune + floor + resetRequired ─────────────────────────────

test('prune by size keeps the newest maxRows and raises the floor', () => {
  // Fresh isolated DB so seq counting is deterministic for this assertion.
  closeDb();
  const dir = mkdtempSync(join(tmpdir(), 'pc-prune-size-'));
  process.env.PC_DATA_DIR = dir;
  runMigrations();

  const inserted = [];
  for (let i = 0; i < 8; i++) inserted.push(insertGlobal(`e${i}`));
  const head = inserted[inserted.length - 1].cursor;

  const result = pruneLiveOutbox({ maxRows: 3 });
  assert.equal(result.deleted, 5);
  // Floor is the lowest surviving seq = head - 2 (3 newest rows survive).
  assert.equal(result.floor, Number(head) - 2);
  assert.equal(getLiveEventFloor(), String(Number(head) - 2));

  // The surviving window is exactly the newest 3 rows.
  const survivors = listLiveOutboxRowsAfter('0', 100);
  assert.equal(survivors.length, 3);
  assert.deepEqual(
    survivors.map((r) => r.entityId),
    ['e5', 'e6', 'e7'],
  );

  closeDb();
  rmSync(dir, { recursive: true, force: true });
  process.env.PC_DATA_DIR = tmpDir;
  runMigrations();
});

test('prune by age drops rows older than maxAgeMs', () => {
  closeDb();
  const dir = mkdtempSync(join(tmpdir(), 'pc-prune-age-'));
  process.env.PC_DATA_DIR = dir;
  runMigrations();

  const now = 1_000_000;
  insertGlobal('old1', now - 10_000);
  insertGlobal('old2', now - 5_000);
  const fresh = insertGlobal('fresh', now - 1_000);

  const result = pruneLiveOutbox({ maxAgeMs: 2_000, now });
  assert.equal(result.deleted, 2);
  const survivors = listLiveOutboxRowsAfter('0', 100);
  assert.deepEqual(
    survivors.map((r) => r.id),
    [fresh.id],
  );

  closeDb();
  rmSync(dir, { recursive: true, force: true });
  process.env.PC_DATA_DIR = tmpDir;
  runMigrations();
});

test('cursor below the pruned floor → resetRequired; cursor at/after floor replays', () => {
  closeDb();
  const dir = mkdtempSync(join(tmpdir(), 'pc-prune-reset-'));
  process.env.PC_DATA_DIR = dir;
  runMigrations();

  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(insertGlobal(`r${i}`));

  // Keep only the newest 2 → floor jumps to (head - 1).
  pruneLiveOutbox({ maxRows: 2 });
  const floor = Number(getLiveEventFloor());

  // A cursor well below the floor cannot be fully replayed → resetRequired,
  // and the events array is empty (no partial replay).
  const stale = listLiveEventsAfter({ after: '1' });
  assert.equal(stale.resetRequired, true);
  assert.deepEqual(stale.events, []);

  // A cursor at exactly (floor - 1) is fine: the first row we'd replay is
  // `floor`, which still exists → no reset.
  const ok = listLiveEventsAfter({ after: String(floor - 1) });
  assert.notEqual(ok.resetRequired, true);
  assert.equal(ok.events.length, 2);

  closeDb();
  rmSync(dir, { recursive: true, force: true });
  process.env.PC_DATA_DIR = tmpDir;
  runMigrations();
});
