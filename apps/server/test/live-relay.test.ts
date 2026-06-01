import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-live-relay-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject,
  getDb,
  insertLiveEvent,
  pruneLiveOutbox,
  runMigrations,
} = await import('@pc/db');
const { LiveRelay } = await import('../src/services/live-relay.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

interface Fan {
  globalAll: unknown[];
  perProject: Map<string, unknown[]>;
}

function fakeHub(fan: Fan) {
  return {
    broadcastAll(msg: unknown): number {
      fan.globalAll.push(msg);
      return 1;
    },
    broadcast(projectId: string, msg: unknown): number {
      const list = fan.perProject.get(projectId) ?? [];
      list.push(msg);
      fan.perProject.set(projectId, list);
      return 1;
    },
  };
}

function fakeSocket() {
  const sent: unknown[] = [];
  return {
    OPEN: 1,
    readyState: 1,
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
  };
}

let fan: Fan;
let relay: InstanceType<typeof LiveRelay>;

beforeEach(() => {
  fan = { globalAll: [], perProject: new Map() };
  relay = new LiveRelay({ hub: fakeHub(fan) });
  // Prime to head so only rows committed AFTER this point are fanned live.
  relay.primeToHead();
});

test('a committed outbox row delivers to subscribed sockets via drain', () => {
  const p = createProject({
    slug: `relay-deliver-${Date.now()}`,
    name: 'Relay Deliver',
    stages,
    folderPath: join(tmpDir, 'relay-deliver'),
  });
  // createProject itself wrote outbox rows; re-prime past them.
  relay.primeToHead();

  insertLiveEvent(getDb(), {
    scope: 'project',
    projectId: p.id,
    type: 'work-item.changed',
    entity: 'work-item',
    entityId: 'wi1' as ULID,
    version: 3,
    payload: { reason: 'created' },
  });
  const globalEvt = insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: p.id,
    version: null,
    payload: { reason: 'reordered' },
  });

  relay.drain();

  // Project row fanned to that project; global row fanned to all.
  const projectFan = fan.perProject.get(p.id) ?? [];
  assert.equal(projectFan.length, 1);
  assert.equal((projectFan[0] as { type: string }).type, 'live-event');
  assert.equal(fan.globalAll.length, 1);
  assert.equal((fan.globalAll[0] as { event: { id: string } }).event.id, globalEvt.id);
});

test('draining twice does not redeliver already-fanned rows (cursor advances)', () => {
  insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: 'gx' as ULID,
    version: null,
    payload: { reason: 'created' },
  });
  relay.drain();
  const firstCount = fan.globalAll.length;
  relay.drain();
  assert.equal(fan.globalAll.length, firstCount, 'second drain must not redeliver');
});

test('zero subscribers: the row stays replayable in the outbox after drain', () => {
  // Hub with no subscribers — broadcast returns 0; the row is NOT consumed/
  // deleted, it lives in the outbox until pruned (replayable via handshake).
  const silentFan: Fan = { globalAll: [], perProject: new Map() };
  const silentRelay = new LiveRelay({
    hub: {
      broadcastAll() { return 0; },
      broadcast() { return 0; },
    },
  });
  silentRelay.primeToHead();
  const evt = insertLiveEvent(getDb(), {
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: 'orphan' as ULID,
    version: null,
    payload: { reason: 'created' },
  });
  silentRelay.drain();
  // Replay from before the row proves it survived (not deleted by delivery).
  const socket = fakeSocket();
  silentRelay.catchUp(socket, String(Number(evt.cursor) - 1), null);
  const ids = socket.sent.map((m) => (m as { event?: { id?: string } }).event?.id);
  assert.ok(ids.includes(evt.id), 'orphaned row must still replay');
});

test('handshake replays (lastVersion, snapshot] then dedupe is the client job', () => {
  const p = createProject({
    slug: `relay-hs-${Date.now()}`,
    name: 'Relay HS',
    stages,
    folderPath: join(tmpDir, 'relay-hs'),
  });
  const before = insertLiveEvent(getDb(), {
    scope: 'project',
    projectId: p.id,
    type: 'work-item.changed',
    entity: 'work-item',
    entityId: 'a' as ULID,
    version: 1,
    payload: {},
  });
  const mid = insertLiveEvent(getDb(), {
    scope: 'project',
    projectId: p.id,
    type: 'work-item.changed',
    entity: 'work-item',
    entityId: 'b' as ULID,
    version: 1,
    payload: {},
  });
  const last = insertLiveEvent(getDb(), {
    scope: 'project',
    projectId: p.id,
    type: 'work-item.changed',
    entity: 'work-item',
    entityId: 'c' as ULID,
    version: 1,
    payload: {},
  });

  // Client cursor = `before` → replay should be (before, last] = mid, last.
  const socket = fakeSocket();
  relay.catchUp(socket, before.cursor, p.id);
  const ids = socket.sent.map((m) => (m as { event: { id: string } }).event.id);
  assert.deepEqual(ids, [mid.id, last.id]);
});

test('a rolled-back transaction delivers nothing (no committed row to drain)', () => {
  const p = createProject({
    slug: `relay-rollback-${Date.now()}`,
    name: 'Relay Rollback',
    stages,
    folderPath: join(tmpDir, 'relay-rollback'),
  });
  relay.primeToHead();
  const localFan: Fan = { globalAll: [], perProject: new Map() };
  const localRelay = new LiveRelay({ hub: fakeHub(localFan) });
  localRelay.primeToHead();

  assert.throws(() => {
    getDb().transaction((tx) => {
      insertLiveEvent(tx, {
        scope: 'project',
        projectId: p.id,
        type: 'work-item.changed',
        entity: 'work-item',
        entityId: 'rb' as ULID,
        version: 1,
        payload: {},
      });
      throw new Error('boom — roll back');
    });
  }, /boom/);

  localRelay.drain();
  assert.equal(localFan.globalAll.length, 0);
  assert.equal((localFan.perProject.get(p.id) ?? []).length, 0);
});

test('handshake with no lastVersion (cold load) replays nothing', () => {
  const socket = fakeSocket();
  relay.catchUp(socket, undefined, null);
  assert.equal(socket.sent.length, 0);
});

test('handshake below the pruned floor sends a single live-reset', () => {
  const p = createProject({
    slug: `relay-reset-${Date.now()}`,
    name: 'Relay Reset',
    stages,
    folderPath: join(tmpDir, 'relay-reset'),
  });
  for (let i = 0; i < 5; i++) {
    insertLiveEvent(getDb(), {
      scope: 'project',
      projectId: p.id,
      type: 'work-item.changed',
      entity: 'work-item',
      entityId: `w${i}` as ULID,
      version: 1,
      payload: {},
    });
  }
  // Prune hard so a low cursor predates the floor.
  pruneLiveOutbox({ maxRows: 1 });

  const socket = fakeSocket();
  relay.catchUp(socket, '1', p.id);
  assert.equal(socket.sent.length, 1);
  assert.equal((socket.sent[0] as { type: string }).type, 'live-reset');
});
