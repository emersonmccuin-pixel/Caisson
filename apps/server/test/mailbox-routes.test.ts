import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-mailbox-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createProject, runMigrations, getPendingInteraction, createPendingInteraction, newId } =
  await import('@pc/db');
const { MailboxService, PendingInteractionService } = await import('@pc/app-services');
const { registerMailboxRoutes } = await import('../src/features/mailbox/routes.ts');
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

// Slice 015b — the mailbox routes no longer hand-fan message frames; the relay
// delivers them from the committed outbox row. The test harness drives a relay
// over the same DB (mirroring the live 250ms drain) and asserts delivery there.
// `broadcasts` now only ever receives pending-interaction (`/answer`) frames —
// the one fanout the mailbox routes still own this commit.
function makeApp() {
  const app = new Hono();
  const broadcasts: { projectId: ULID | null; event: unknown }[] = [];
  const fan: Fan = { globalAll: [], perProject: new Map() };
  const relay = new LiveRelay({
    hub: {
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
    },
  });
  relay.primeToHead();
  registerMailboxRoutes(app, {
    mailbox: new MailboxService(),
    interactions: new PendingInteractionService(),
    broadcastTo: (projectId, event) => broadcasts.push({ projectId, event }),
  });
  // Drain the relay and return what reached each scope.
  const drain = () => {
    relay.drain();
    return fan;
  };
  return { app, broadcasts, drain, fan };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

test('enqueue → project inbox lists it → read/dismiss updates recipient state', async () => {
  const { app, broadcasts, drain, fan } = makeApp();
  const project = createProject({
    slug: `mbx-${Date.now()}`,
    name: 'Mailbox P',
    stages,
    folderPath: join(tmpDir, 'mbx'),
  });

  const enq = await app.request(`/api/projects/${project.id}/mailbox/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'system-notice',
      body: 'hello inbox',
      idempotencyKey: `k-${Date.now()}`,
      recipients: [{ address: { kind: 'project-inbox', projectId: project.id }, channel: 'ui-inbox' }],
    }),
  });
  assert.equal(enq.status, 200);
  const enqBody = await json<{ ok: boolean; created: boolean; recipients: { id: string }[] }>(enq);
  assert.equal(enqBody.ok, true);
  assert.equal(enqBody.created, true);
  const recipientId = enqBody.recipients[0]!.id;
  // Slice 015b — the route does NOT hand-fan; the relay delivers the canonical
  // `mailbox.message.changed` frame from the committed outbox row, exactly once,
  // to this project's scope. No message frame lands on the hand `broadcasts`.
  drain();
  const projectFan = fan.perProject.get(project.id) ?? [];
  assert.equal(projectFan.length, 1, 'relay delivers exactly one frame for the project');
  assert.equal((projectFan[0] as { type: string }).type, 'live-event');
  assert.equal(
    (projectFan[0] as { event: { type: string } }).event.type,
    'mailbox.message.changed',
  );
  assert.equal(fan.globalAll.length, 0, 'project enqueue must not reach the global scope');
  assert.equal(broadcasts.length, 0, 'no mailbox-message hand-fanout remains');

  const list = await app.request(`/api/projects/${project.id}/mailbox`);
  const listBody = await json<{ items: { recipient: { id: string }; message: { body: string } }[] }>(list);
  assert.equal(listBody.items.length, 1);
  assert.equal(listBody.items[0]!.message.body, 'hello inbox');

  const read = await app.request(`/api/projects/${project.id}/mailbox/recipients/${recipientId}/read`, {
    method: 'POST',
  });
  assert.equal(read.status, 200);

  const unread = await app.request(`/api/projects/${project.id}/mailbox?unreadOnly=1`);
  assert.equal((await json<{ items: unknown[] }>(unread)).items.length, 0);
});

test('a rolled-back mailbox enqueue delivers nothing (no committed outbox row)', async () => {
  const { drain, fan } = makeApp();
  const { getDb, insertLiveEvent } = await import('@pc/db');
  const project = createProject({
    slug: `mbx-rb-${Date.now()}`,
    name: 'Mailbox Rollback',
    stages,
    folderPath: join(tmpDir, 'mbx-rb'),
  });
  // createProject wrote rows; advance the relay cursor past them.
  drain();
  const baseGlobal = fan.globalAll.length;
  const baseProject = (fan.perProject.get(project.id) ?? []).length;

  // Simulate a mailbox-message outbox write that rolls back — the relay must
  // never deliver it (delivery ≡ a COMMITTED outbox row).
  assert.throws(() => {
    getDb().transaction((tx) => {
      insertLiveEvent(tx, {
        scope: 'project',
        projectId: project.id,
        type: 'mailbox.message.changed',
        entity: 'mailbox-message',
        entityId: newId(),
        version: null,
        payload: {},
      });
      throw new Error('boom — roll back');
    });
  }, /boom/);

  drain();
  assert.equal(fan.globalAll.length, baseGlobal, 'rolled-back row must not reach global');
  assert.equal((fan.perProject.get(project.id) ?? []).length, baseProject, 'rolled-back row must not reach the project');
});

test('enqueue is idempotent by key (replay → created:false)', async () => {
  const { app } = makeApp();
  const project = createProject({
    slug: `mbx-idem-${Date.now()}`,
    name: 'Mailbox Idem',
    stages,
    folderPath: join(tmpDir, 'mbx-idem'),
  });
  const key = `idem-${Date.now()}`;
  const body = JSON.stringify({
    kind: 'system-notice',
    body: 'x',
    idempotencyKey: key,
    recipients: [{ address: { kind: 'project-inbox', projectId: project.id }, channel: 'ui-inbox' }],
  });
  await app.request(`/api/projects/${project.id}/mailbox/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const second = await app.request(`/api/projects/${project.id}/mailbox/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal((await json<{ created: boolean }>(second)).created, false);
});

test('delivery inspector returns deliveries; bad request is 400', async () => {
  const { app } = makeApp();
  const project = createProject({
    slug: `mbx-del-${Date.now()}`,
    name: 'Mailbox Del',
    stages,
    folderPath: join(tmpDir, 'mbx-del'),
  });
  await app.request(`/api/projects/${project.id}/mailbox/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'system-notice',
      body: 'x',
      idempotencyKey: `dk-${Date.now()}`,
      recipients: [{ address: { kind: 'project-inbox', projectId: project.id }, channel: 'ui-inbox' }],
    }),
  });
  const inspector = await app.request(`/api/projects/${project.id}/mailbox/deliveries`);
  const body = await json<{ deliveries: { status: string }[] }>(inspector);
  assert.equal(body.deliveries.length, 1);
  assert.equal(body.deliveries[0]!.status, 'pending');

  const bad = await app.request(`/api/projects/${project.id}/mailbox/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'system-notice', body: 'x', recipients: [] }),
  });
  assert.equal(bad.status, 400);
});

test('app-level enqueue with a project-less user-inbox recipient → global inbox', async () => {
  const { app, broadcasts, drain, fan } = makeApp();
  const enq = await app.request('/api/mailbox/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'system-notice',
      body: 'global hello',
      idempotencyKey: `g-${Date.now()}`,
      recipients: [
        { address: { kind: 'user-inbox', userId: 'local-user', projectId: null }, channel: 'ui-inbox' },
      ],
    }),
  });
  assert.equal(enq.status, 200);
  const enqBody = await json<{ ok: boolean; message: { projectId: string | null } }>(enq);
  assert.equal(enqBody.ok, true);
  // The message is stored project-less so it lands in the global inbox…
  assert.equal(enqBody.message.projectId, null);
  // …and the relay delivers a global (`scope:'global'`) frame to all sockets.
  // The web `shouldAcceptMailboxWsEnvelope` accepts canonical frames regardless
  // of projectId, so `broadcastAll` reaches the single-user inbox consumer.
  drain();
  assert.ok(
    fan.globalAll.some(
      (m) => (m as { event?: { type?: string } }).event?.type === 'mailbox.message.changed',
    ),
    'relay delivers the global mailbox frame to all sockets',
  );
  assert.equal(broadcasts.length, 0, 'no mailbox-message hand-fanout remains');

  const list = await app.request('/api/mailbox');
  const body = await json<{ items: { message: { body: string } }[] }>(list);
  assert.ok(body.items.some((i) => i.message.body === 'global hello'));
});

test('app-level enqueue derives projectId from a project-bound recipient', async () => {
  const { app } = makeApp();
  const project = createProject({
    slug: `mbx-derive-${Date.now()}`,
    name: 'Mailbox Derive',
    stages,
    folderPath: join(tmpDir, 'mbx-derive'),
  });
  const enq = await app.request('/api/mailbox/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'system-notice',
      body: 'scoped via app route',
      idempotencyKey: `d-${Date.now()}`,
      recipients: [{ address: { kind: 'project-inbox', projectId: project.id }, channel: 'ui-inbox' }],
    }),
  });
  const enqBody = await json<{ message: { projectId: string | null } }>(enq);
  assert.equal(enqBody.message.projectId, project.id);
  // It is NOT in the global inbox…
  const global = await app.request('/api/mailbox');
  assert.ok(!(await json<{ items: { message: { body: string } }[] }>(global)).items.some(
    (i) => i.message.body === 'scoped via app route',
  ));
  // …but IS in the project inbox.
  const proj = await app.request(`/api/projects/${project.id}/mailbox`);
  assert.ok((await json<{ items: { message: { body: string } }[] }>(proj)).items.some(
    (i) => i.message.body === 'scoped via app route',
  ));
});

test('answer a pending interaction route (404 unknown, 200 ok, 409 already terminal)', async () => {
  const { app } = makeApp();
  const project = createProject({
    slug: `mbx-int-${Date.now()}`,
    name: 'Mailbox Int',
    stages,
    folderPath: join(tmpDir, 'mbx-int'),
  });
  const missing = await app.request(`/api/projects/${project.id}/pending-interactions/nope/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'y', answeredBy: 'user' }),
  });
  assert.equal(missing.status, 404);

  const interaction = createPendingInteraction({
    id: newId(),
    projectId: project.id,
    kind: 'runtime-hook-ask',
    sourceKind: 'runtime-hook',
    sourceId: `tool-${Date.now()}`,
    prompt: 'pick',
    now: Date.now(),
  });
  const ok = await app.request(`/api/projects/${project.id}/pending-interactions/${interaction.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'yes', answeredBy: 'user' }),
  });
  assert.equal(ok.status, 200);
  assert.equal(getPendingInteraction(interaction.id)!.status, 'answered');

  const replay = await app.request(`/api/projects/${project.id}/pending-interactions/${interaction.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'no', answeredBy: 'user' }),
  });
  assert.equal(replay.status, 409);
});
